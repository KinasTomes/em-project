const axios = require('axios')
const mongoose = require('mongoose')
const Order = require('../models/order')
const logger = require('@ecommerce/logger')
const { createOrderStateMachine } = require('./orderStateMachine')

class OrderService {
	constructor(outboxManager) {
		this.outboxManager = outboxManager
		this.productServiceUrl =
			process.env.PRODUCT_SERVICE_URL || 'http://product:3004'
	}

	/**
	 * Fetch product details from the Product service and validate the IDs.
	 */
	async validateProducts(productIds, token) {
		try {
			const authHeader =
				token && token.startsWith('Bearer ') ? token : `Bearer ${token}`

			const response = await axios.get(
				`${this.productServiceUrl}/api/products`,
				{
					headers: { Authorization: authHeader },
					timeout: 5000,
				}
			)

			if (response.status !== 200) {
				throw new Error(`Product Service returned status ${response.status}`)
			}

			const allProducts = response.data
			const validProducts = allProducts.filter((product) =>
				productIds.includes(product._id.toString())
			)

			if (validProducts.length !== productIds.length) {
				const foundIds = validProducts.map((product) => product._id.toString())
				const missingIds = productIds.filter((id) => !foundIds.includes(id))
				throw new Error(`Products not found: ${missingIds.join(', ')}`)
			}

			return validProducts
		} catch (error) {
			logger.error(
				{ error: error.message, productIds },
				'Failed to validate products'
			)
			throw error
		}
	}

	/**
	 * Create a new order and enqueue reserve requests via the outbox.
	 */
	async createOrder(productIds, quantities = [], username, token) {
		if (!Array.isArray(productIds) || productIds.length === 0) {
			throw new Error('Product IDs are required')
		}

		const normalizedQuantities =
			Array.isArray(quantities) && quantities.length === productIds.length
				? quantities.map((quantity) => {
						const parsed = Number(quantity)
						return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
				  })
				: productIds.map(() => 1)

		const products = await this.validateProducts(productIds, token)

		const totalPrice = products.reduce((total, product, index) => {
			const price = Number(product?.price || 0)
			return (
				total +
				(Number.isFinite(price) ? price : 0) * normalizedQuantities[index]
			)
		}, 0)

		const session = await mongoose.startSession()
		session.startTransaction()

		try {
			const order = new Order({
				products: products.map((product, index) => ({
					_id: product._id,
					name: product.name,
					price: product.price,
					description: product.description,
					quantity: normalizedQuantities[index],
					reserved: false,
				})),
				user: username,
				totalPrice,
				status: 'PENDING',
			})

			await order.save({ session })
			const orderId = order._id.toString()

			if (!this.outboxManager) {
				throw new Error('OutboxManager not initialized')
			}

			const timestamp = new Date().toISOString()
			for (const product of order.products) {
				await this.outboxManager.createEvent({
					eventType: 'INVENTORY_RESERVE_REQUEST',
					payload: {
						type: 'RESERVE',
						data: {
							orderId,
							productId: product._id.toString(),
							quantity: product.quantity,
						},
						timestamp,
					},
					session,
					correlationId: orderId,
					destination: 'inventory',
				})
			}

			await session.commitTransaction()
			logger.info(
				{ orderId, username },
				'Order created via transactional outbox'
			)

			return {
				orderId,
				message: 'Order created and reservation requests queued',
				products: order.products.map((product) => ({
					id: product._id,
					name: product.name,
					price: product.price,
					quantity: product.quantity,
				})),
				totalPrice,
				status: order.status,
			}
		} catch (error) {
			await session.abortTransaction()
			logger.error(
				{ error: error.message, username },
				'Failed to create order, transaction rolled back'
			)
			throw error
		} finally {
			session.endSession()
		}
	}

	async getOrderById(orderId) {
		try {
			return await Order.findById(orderId)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'Failed to get order by id'
			)
			throw error
		}
	}

	/**
	 * Handle INVENTORY_RESERVED event
	 */
	async handleInventoryReserved(payload, correlationId) {
		logger.info(
			{ orderId: payload.orderId, productId: payload.productId, correlationId },
			'[Order] Processing INVENTORY_RESERVED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'[Order] Order not found for INVENTORY_RESERVED'
			)
			return
		}

		// Check if order is already in final state
		const fsm = createOrderStateMachine(order.status)
		if (fsm.isFinalState()) {
			logger.warn(
				{
					orderId: payload.orderId,
					currentStatus: order.status,
					correlationId,
				},
				'[Order] Order already in final state, skipping inventory reserved update'
			)
			return
		}

		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				let changed = false
				order.products = order.products.map((product) => {
					if (product._id.toString() === payload.productId) {
						changed = true
						return { ...product.toObject(), reserved: true }
					}
					return product
				})

				if (changed) {
					const allReserved = order.products.every(
						(product) => product.reserved === true
					)
					if (allReserved) {
						// Use state machine to validate transition: PENDING → CONFIRMED
						try {
							fsm.confirm()
							order.status = fsm.getState()
							
							logger.info(
								{
									orderId: order._id,
									oldStatus: 'PENDING',
									newStatus: order.status,
									correlationId,
								},
								'[Order] Order status updated to CONFIRMED (all inventory reserved)'
							)

							await this.outboxManager.createEvent({
								eventType: 'ORDER_CONFIRMED',
								payload: {
									orderId: order._id,
									totalPrice: order.totalPrice,
									currency: 'USD',
									products: order.products.map((p) => ({
										productId: p._id.toString(),
										quantity: p.quantity,
										price: p.price,
									})),
									userId: order.user,
									timestamp: new Date().toISOString(),
								},
								session,
								correlationId,
							})
						} catch (error) {
							logger.error(
								{
									error: error.message,
									orderId: payload.orderId,
									currentStatus: order.status,
									correlationId,
								},
								'[Order] Invalid state transition for INVENTORY_RESERVED'
							)
							throw error
						}
					}

					await order.save({ session })
				}
			})
		} finally {
			session.endSession()
		}
	}

	/**
	 * Handle INVENTORY_RESERVE_FAILED event
	 * Includes compensation logic for partial failures
	 */
	async handleInventoryReserveFailed(payload, correlationId) {
		logger.warn(
			{
				orderId: payload.orderId,
				reason: payload.reason,
				correlationId,
			},
			'[Order] Processing INVENTORY_RESERVE_FAILED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'[Order] Order not found for INVENTORY_RESERVE_FAILED'
			)
			return
		}

		// Check if order is already in final state
		const fsm = createOrderStateMachine(order.status)
		if (fsm.isFinalState()) {
			logger.warn(
				{
					orderId: payload.orderId,
					currentStatus: order.status,
					correlationId,
				},
				'[Order] Order already in final state, skipping transition'
			)
			return
		}

		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				// Use state machine to validate transition
				try {
					fsm.cancel()
					order.status = fsm.getState()
					order.cancellationReason = payload.reason || 'Inventory reserve failed'
					await order.save({ session })

					logger.info(
						{
							orderId: order._id,
							oldStatus: 'PENDING',
							newStatus: order.status,
							cancellationReason: order.cancellationReason,
							correlationId,
						},
						'[Order] Order status updated to CANCELLED (inventory reserve failed)'
					)

					// ✅ FIX: Release reserved inventory (compensation for partial failure)
					const reservedProducts = order.products.filter(p => p.reserved === true)
					
					if (reservedProducts.length > 0) {
						logger.info(
							{ 
								orderId: order._id, 
								reservedCount: reservedProducts.length,
								products: reservedProducts.map(p => ({
									productId: p._id.toString(),
									quantity: p.quantity
								})),
								correlationId 
							},
							'[Order] Releasing reserved inventory (compensation for partial failure)'
						)

						for (const product of reservedProducts) {
							await this.outboxManager.createEvent({
								eventType: 'INVENTORY_RELEASE_REQUEST',
								payload: {
									type: 'RELEASE',
									data: {
										orderId: order._id,
										productId: product._id.toString(),
										quantity: product.quantity,
										reason: 'INVENTORY_RESERVE_FAILED_PARTIAL',
									},
									timestamp: new Date().toISOString(),
								},
								session,
								correlationId,
								destination: 'inventory',
							})
						}
					}

					await this.outboxManager.createEvent({
						eventType: 'ORDER_CANCELLED',
						payload: {
							orderId: order._id,
							reason: order.cancellationReason,
							timestamp: new Date().toISOString(),
						},
						session,
						correlationId,
					})
				} catch (error) {
					logger.error(
						{
							error: error.message,
							orderId: payload.orderId,
							currentStatus: order.status,
							correlationId,
						},
						'[Order] Invalid state transition for INVENTORY_RESERVE_FAILED'
					)
					throw error
				}
			})
		} finally {
			session.endSession()
		}
	}

	/**
	 * Handle PAYMENT_SUCCEEDED event
	 */
	async handlePaymentSucceeded(payload, correlationId) {
		logger.info(
			{
				orderId: payload.orderId,
				transactionId: payload.transactionId,
				correlationId,
			},
			'[Order] Processing PAYMENT_SUCCEEDED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'[Order] Order not found for PAYMENT_SUCCEEDED'
			)
			return
		}

		// Check if order is already in final state
		const fsm = createOrderStateMachine(order.status)
		if (fsm.isFinalState()) {
			logger.warn(
				{
					orderId: payload.orderId,
					currentStatus: order.status,
					correlationId,
				},
				'[Order] Order already in final state, skipping transition'
			)
			return
		}

		// Validate that order is in CONFIRMED state before payment
		if (order.status !== 'CONFIRMED') {
			logger.error(
				{
					orderId: payload.orderId,
					currentStatus: order.status,
					correlationId,
				},
				'[Order] Cannot process payment: Order must be CONFIRMED before payment. Current status: ' +
					order.status
			)
			return
		}

		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				// Use state machine to validate transition: CONFIRMED → PAID
				try {
					fsm.pay()
					order.status = fsm.getState()
					await order.save({ session })

					logger.info(
						{
							orderId: order._id,
							oldStatus: 'CONFIRMED',
							newStatus: order.status,
							transactionId: payload.transactionId,
							correlationId,
						},
						'[Order] Order status updated to PAID (payment succeeded)'
					)

					await this.outboxManager.createEvent({
						eventType: 'ORDER_PAID',
						payload: {
							orderId: order._id,
							transactionId: payload.transactionId,
							amount: payload.amount,
							currency: payload.currency,
							timestamp: new Date().toISOString(),
						},
						session,
						correlationId,
					})
				} catch (error) {
					logger.error(
						{
							error: error.message,
							orderId: payload.orderId,
							currentStatus: order.status,
							correlationId,
						},
						'[Order] Invalid state transition for PAYMENT_SUCCEEDED'
					)
					throw error
				}
			})
		} finally {
			session.endSession()
		}
	}

	/**
	 * Handle PAYMENT_FAILED event
	 * Includes compensation logic to release reserved inventory
	 */
	async handlePaymentFailed(payload, correlationId) {
		logger.warn(
			{
				orderId: payload.orderId,
				reason: payload.reason,
				transactionId: payload.transactionId,
				correlationId,
			},
			'[Order] Processing PAYMENT_FAILED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'[Order] Order not found for PAYMENT_FAILED'
			)
			return
		}

		// Check if order is already in final state
		const fsm = createOrderStateMachine(order.status)
		if (fsm.isFinalState()) {
			logger.warn(
				{
					orderId: payload.orderId,
					currentStatus: order.status,
					correlationId,
				},
				'[Order] Order already in final state, skipping transition'
			)
			return
		}

		// Validate that order is in CONFIRMED state
		if (order.status !== 'CONFIRMED') {
			logger.error(
				{
					orderId: payload.orderId,
					currentStatus: order.status,
					correlationId,
				},
				'[Order] Cannot process payment failure: Order must be CONFIRMED. Current status: ' +
					order.status
			)
			return
		}

		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				// Use state machine to validate transition: CONFIRMED → CANCELLED
				try {
					fsm.cancel()
					order.status = fsm.getState()
					order.cancellationReason = payload.reason || 'Payment failed'
					await order.save({ session })

					logger.info(
						{
							orderId: order._id,
							oldStatus: 'CONFIRMED',
							newStatus: order.status,
							cancellationReason: order.cancellationReason,
							transactionId: payload.transactionId,
							correlationId,
						},
						'[Order] Order status updated to CANCELLED (payment failed)'
					)

					// Release reserved inventory (compensation)
					for (const product of order.products) {
						if (product.reserved) {
							await this.outboxManager.createEvent({
								eventType: 'INVENTORY_RELEASE_REQUEST',
								payload: {
									type: 'RELEASE',
									data: {
										orderId: order._id,
										productId: product._id.toString(),
										quantity: product.quantity,
										reason: 'PAYMENT_FAILED',
									},
									timestamp: new Date().toISOString(),
								},
								session,
								correlationId,
								destination: 'inventory',
							})
						}
					}

					await this.outboxManager.createEvent({
						eventType: 'ORDER_CANCELLED',
						payload: {
							orderId: order._id,
							reason: order.cancellationReason,
							timestamp: new Date().toISOString(),
						},
						session,
						correlationId,
					})
				} catch (error) {
					logger.error(
						{
							error: error.message,
							orderId: payload.orderId,
							currentStatus: order.status,
							correlationId,
						},
						'[Order] Invalid state transition for PAYMENT_FAILED'
					)
					throw error
				}
			})
		} finally {
			session.endSession()
		}
	}
}

module.exports = OrderService
