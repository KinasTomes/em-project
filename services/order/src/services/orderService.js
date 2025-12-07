const mongoose = require('mongoose')
const orderRepository = require('../repositories/orderRepository')
const logger = require('@ecommerce/logger')
const { createOrderStateMachine } = require('./orderStateMachine')
const { productClient } = require('../clients/productClient')
const {
	recordOrderCreated,
	recordStateTransition,
	recordSagaOperation,
	recordOrderValue,
	recordOrderOperation,
	recordEventProcessing,
	startEventProcessingTimer,
	startProductValidationTimer,
	updateCircuitBreakerFromStats
} = require('../metrics')

// Helper function for getting traceId as correlationId
const { getCurrentTraceId } = require('@ecommerce/tracing')

/**
 * Helper: Check if error is a MongoDB Write Conflict (retryable)
 */
function isWriteConflict(error) {
	return error && error.message && (
		error.message.includes('Write conflict') ||
		error.message.includes('WriteConflict') ||
		error.code === 112
	)
}

/**
 * Helper: Execute transaction with retry logic for Write Conflicts
 * @param {Function} transactionFn - Async function that receives session
 * @param {Object} options - { maxRetries, retryDelayMs, operationName }
 */
async function withRetryTransaction(transactionFn, options = {}) {
	const { maxRetries = 3, retryDelayMs = 100, operationName = 'transaction' } = options

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				await transactionFn(session)
			})
			session.endSession()
			return // Success
		} catch (error) {
			session.endSession()

			if (isWriteConflict(error) && attempt < maxRetries) {
				logger.warn(
					{ attempt, maxRetries, error: error.message, operationName },
					`⚠️ [Order] Write conflict detected, retrying ${operationName} (${attempt}/${maxRetries})...`
				)
				await new Promise(resolve => setTimeout(resolve, retryDelayMs * Math.pow(2, attempt - 1)))
				continue
			}

			throw error // Non-retryable or max retries exceeded
		}
	}
}

class OrderService {
	constructor(outboxManager) {
		this.outboxManager = outboxManager
	}

	/**
	 * Fetch product details from the Product service and validate the IDs.
	 * Uses circuit breaker for resilient HTTP calls.
	 */
	async validateProducts(productIds, token) {
		const endTimer = startProductValidationTimer()
		try {
			const authHeader =
				token && token.startsWith('Bearer ') ? token : `Bearer ${token}`

			// Use resilient client with circuit breaker
			const allProducts = await productClient.get('/api/products', {
				headers: { Authorization: authHeader },
			})

			const validProducts = allProducts.filter((product) =>
				productIds.includes(product._id.toString())
			)

			if (validProducts.length !== productIds.length) {
				const foundIds = validProducts.map((product) => product._id.toString())
				const missingIds = productIds.filter((id) => !foundIds.includes(id))
				endTimer('failed')
				throw new Error(`Products not found: ${missingIds.join(', ')}`)
			}

			// Update circuit breaker metrics
			updateCircuitBreakerFromStats(productClient.getStats())
			endTimer('success')
			return validProducts
		} catch (error) {
			// Handle circuit breaker specific errors
			if (error.code === 'CIRCUIT_OPEN') {
				logger.error(
					{ productIds, circuitState: 'OPEN' },
					'Product Service is unavailable (circuit breaker open)'
				)
				updateCircuitBreakerFromStats(productClient.getStats())
				endTimer('circuit_open')
				throw new Error(
					'Product Service is temporarily unavailable. Please try again later.'
				)
			}

			if (error.code === 'TIMEOUT') {
				logger.error(
					{ productIds, timeout: 3000 },
					'Product Service request timed out'
				)
				endTimer('timeout')
				throw new Error(
					'Product Service is taking too long to respond. Please try again.'
				)
			}

			// Log and re-throw other errors
			logger.error(
				{ error: error.message, productIds, code: error.code },
				'Failed to validate products'
			)
			endTimer('failed')
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
			const orderData = {
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
			}

			const order = await orderRepository.create(orderData, session)
			const orderId = order._id.toString()

			if (!this.outboxManager) {
				throw new Error('OutboxManager not initialized')
			}

			// Get traceId from OpenTelemetry context for correlation
			// This ensures the same traceId is used throughout the entire order flow
			const traceId = getCurrentTraceId()

			const timestamp = new Date().toISOString()
			await this.outboxManager.createEvent({
				eventType: 'ORDER_CREATED',
				payload: {
					type: 'ORDER_CREATED',
					data: {
						orderId,
						products: order.products.map((product) => ({
							productId: product._id.toString(),
							quantity: product.quantity,
						})),
					},
					timestamp,
				},
				session,
				// Use traceId as correlationId for distributed tracing
				// If no active span, OutboxManager will auto-generate correlationId
				correlationId: traceId,
				routingKey: 'order.created',
			})

			await session.commitTransaction()
			logger.info(
				{ orderId, username },
				'Order created via transactional outbox'
			)

			// Record metrics
			recordOrderCreated('pending')
			recordOrderValue(totalPrice, 'USD', 'created')
			recordSagaOperation('order_flow', 'create', 'success')

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
			recordOrderCreated('failed')
			recordSagaOperation('order_flow', 'create', 'failed')
			throw error
		} finally {
			session.endSession()
		}
	}

	async getOrderById(orderId) {
		try {
			return await orderRepository.findById(orderId)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'Failed to get order by id'
			)
			throw error
		}
	}

	/**
	 * Get orders by user with pagination
	 */
	async getOrdersByUser(username, page = 1, limit = 20) {
		try {
			return await orderRepository.findByUser(username, page, limit)
		} catch (error) {
			logger.error(
				{ error: error.message, username },
				'Failed to get orders by user'
			)
			throw error
		}
	}

	/**
	 * Get order by correlationId (for seckill orders)
	 * Used by clients to look up order status using the correlationId returned by seckill service
	 * 
	 * @param {string} correlationId - Correlation ID from seckill service
	 * @returns {Promise<Object|null>} Order document or null
	 */
	async getOrderByCorrelationId(correlationId) {
		try {
			return await orderRepository.findByCorrelationId(correlationId)
		} catch (error) {
			logger.error(
				{ error: error.message, correlationId },
				'Failed to get order by correlationId'
			)
			throw error
		}
	}

	/**
	 * Handle INVENTORY_RESERVED event
	 */
	async handleInventoryReserved(payload, correlationId) {
		const endTimer = startEventProcessingTimer('inventory_reserved')
		logger.info(
			{ orderId: payload.orderId, productId: payload.productId, correlationId },
			'[Order] Processing INVENTORY_RESERVED'
		)

		try {
			await withRetryTransaction(async (session) => {
				// Read order INSIDE transaction with session for proper locking
				const order = await orderRepository.findById(payload.orderId, session)
				if (!order) {
					logger.warn(
						{ orderId: payload.orderId, correlationId },
						'[Order] Order not found for INVENTORY_RESERVED'
					)
					recordEventProcessing('inventory_reserved', 'skipped')
					return
				}

				// Check if order is already in final state
				const fsm = createOrderStateMachine(order.status)
				if (fsm.isFinalState()) {
					logger.warn(
						{
							orderId: payload.orderId,
							productId: payload.productId,
							currentStatus: order.status,
							correlationId,
						},
						'[Order] Order already in final state, need to release this reserved inventory'
					)

					// If order is already CANCELLED, release this inventory immediately
					if (order.status === 'CANCELLED') {
						await this.outboxManager.createEvent({
							eventType: 'INVENTORY_RELEASE_REQUEST',
							payload: {
								type: 'RELEASE',
								data: {
									orderId: order._id,
									productId: payload.productId,
									quantity: payload.quantity,
									reason: 'ORDER_ALREADY_CANCELLED',
								},
								timestamp: new Date().toISOString(),
							},
							session,
							correlationId,
							routingKey: 'order.release',
						})

						logger.info(
							{
								orderId: order._id,
								productId: payload.productId,
								quantity: payload.quantity,
								correlationId,
							},
							'[Order] Released inventory for cancelled order (race condition compensation)'
						)
						recordSagaOperation('order_flow', 'reserve', 'compensated')
					}

					recordEventProcessing('inventory_reserved', 'skipped')
					return
				}

				// Mark all products as reserved
				order.products.forEach((product) => {
					product.reserved = true
				})

				// Use state machine to validate transition: PENDING → CONFIRMED
				const oldStatus = order.status
				fsm.confirm()
				order.status = fsm.getState()

				// If status didn't change (idempotent), skip the rest
				if (oldStatus === order.status) {
					logger.info(
						{ orderId: order._id, status: order.status, correlationId },
						'[Order] Order already in target state, skipping (idempotent)'
					)
					recordEventProcessing('inventory_reserved', 'skipped')
					return
				}

				logger.info(
					{
						orderId: order._id,
						oldStatus,
						newStatus: order.status,
						correlationId,
					},
					'[Order] Order status updated to CONFIRMED (all inventory reserved)'
				)

				// Record state transition metrics
				recordStateTransition(oldStatus, 'CONFIRMED', 'inventory_reserved')
				recordSagaOperation('order_flow', 'reserve', 'success')
				recordOrderValue(order.totalPrice, 'USD', 'confirmed')

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
					routingKey: 'order.confirmed',
				})

				await orderRepository.save(order, session)
			}, { operationName: 'handleInventoryReserved' })

			endTimer()
			recordEventProcessing('inventory_reserved', 'success')
		} catch (error) {
			logger.error(
				{
					error: error.message,
					orderId: payload.orderId,
					correlationId,
				},
				'[Order] Error processing INVENTORY_RESERVED'
			)
			endTimer()
			recordEventProcessing('inventory_reserved', 'failed')
			throw error
		}
	}

	/**
	 * Handle INVENTORY_RESERVE_FAILED event
	 * Includes compensation logic for partial failures
	 */
	async handleInventoryReserveFailed(payload, correlationId) {
		const endTimer = startEventProcessingTimer('inventory_reserve_failed')
		logger.warn(
			{
				orderId: payload.orderId,
				productId: payload.productId,
				reason: payload.reason,
				fullPayload: JSON.stringify(payload),
				correlationId,
			},
			'[Order] Processing INVENTORY_RESERVE_FAILED'
		)

		try {
			await withRetryTransaction(async (session) => {
				// Read order INSIDE transaction with session for proper locking
				const order = await orderRepository.findById(payload.orderId, session)
				if (!order) {
					logger.warn(
						{ orderId: payload.orderId, correlationId },
						'[Order] Order not found for INVENTORY_RESERVE_FAILED'
					)
					recordEventProcessing('inventory_reserve_failed', 'skipped')
					return
				}

				logger.info(
					{
						orderId: payload.orderId,
						currentStatus: order.status,
						currentCancellationReason: order.cancellationReason,
						products: order.products.map(p => ({
							id: p._id.toString(),
							reserved: p.reserved
						})),
						correlationId,
					},
					'[Order] Current order state before processing INVENTORY_RESERVE_FAILED'
				)

				// Check if order is already in final state
				const fsm = createOrderStateMachine(order.status)
				if (fsm.isFinalState()) {
					logger.warn(
						{
							orderId: payload.orderId,
							currentStatus: order.status,
							existingCancellationReason: order.cancellationReason,
							correlationId,
						},
						'[Order] Order already in final state, skipping transition'
					)
					recordEventProcessing('inventory_reserve_failed', 'skipped')
					return
				}

				// Use state machine to validate transition
				const oldStatus = order.status
				fsm.cancel()
				order.status = fsm.getState()

				// If status didn't change (idempotent), skip the rest
				if (oldStatus === order.status) {
					logger.info(
						{ orderId: order._id, status: order.status, correlationId },
						'[Order] Order already in target state, skipping (idempotent)'
					)
					recordEventProcessing('inventory_reserve_failed', 'skipped')
					return
				}

				const failureReason = payload.reason || payload.message || 'Inventory reserve failed'
				order.cancellationReason = failureReason

				await orderRepository.save(order, session)

				logger.info(
					{
						orderId: order._id,
						oldStatus,
						newStatus: order.status,
						cancellationReason: order.cancellationReason,
						correlationId,
					},
					'[Order] Order status updated to CANCELLED (inventory reserve failed)'
				)

				// Record state transition and saga metrics
				recordStateTransition(oldStatus, 'CANCELLED', 'inventory_failed')
				recordSagaOperation('order_flow', 'reserve', 'failed')
				recordOrderValue(order.totalPrice, 'USD', 'cancelled')

				// Compensation: Release seckill slot if this is a seckill order
				const isSeckill = order.metadata?.source === 'seckill'
				if (isSeckill) {
					await this._publishSeckillRelease(order, session, correlationId, 'INVENTORY_RESERVE_FAILED')
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
					routingKey: 'order.cancelled',
				})
			}, { operationName: 'handleInventoryReserveFailed' })

			endTimer()
			recordEventProcessing('inventory_reserve_failed', 'success')
		} catch (error) {
			logger.error(
				{
					error: error.message,
					orderId: payload.orderId,
					correlationId,
				},
				'[Order] Error processing INVENTORY_RESERVE_FAILED'
			)
			endTimer()
			recordEventProcessing('inventory_reserve_failed', 'failed')
			throw error
		}
	}

	/**
	 * Handle PAYMENT_SUCCEEDED event
	 */
	async handlePaymentSucceeded(payload, correlationId) {
		const endTimer = startEventProcessingTimer('payment_succeeded')
		logger.info(
			{
				orderId: payload.orderId,
				transactionId: payload.transactionId,
				correlationId,
			},
			'[Order] Processing PAYMENT_SUCCEEDED'
		)

		try {
			await withRetryTransaction(async (session) => {
				// Read order INSIDE transaction with session for proper locking
				const order = await orderRepository.findById(payload.orderId, session)
				if (!order) {
					logger.warn(
						{ orderId: payload.orderId, correlationId },
						'[Order] Order not found for PAYMENT_SUCCEEDED'
					)
					recordEventProcessing('payment_succeeded', 'skipped')
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
					recordEventProcessing('payment_succeeded', 'skipped')
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
					recordEventProcessing('payment_succeeded', 'failed')
					return
				}

				// Use state machine to validate transition: CONFIRMED → PAID
				const oldStatus = order.status
				fsm.pay()
				order.status = fsm.getState()

				// If status didn't change (idempotent), skip the rest
				if (oldStatus === order.status) {
					logger.info(
						{ orderId: order._id, status: order.status, correlationId },
						'[Order] Order already in target state, skipping (idempotent)'
					)
					recordEventProcessing('payment_succeeded', 'skipped')
					return
				}

				await orderRepository.save(order, session)

				logger.info(
					{
						orderId: order._id,
						oldStatus,
						newStatus: order.status,
						transactionId: payload.transactionId,
						correlationId,
					},
					'[Order] Order status updated to PAID (payment succeeded)'
				)

				// Record state transition and saga metrics
				recordStateTransition(oldStatus, 'PAID', 'payment_success')
				recordSagaOperation('order_flow', 'payment', 'success')
				recordOrderValue(order.totalPrice, 'USD', 'paid')

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
					routingKey: 'order.paid',
				})
			}, { operationName: 'handlePaymentSucceeded' })

			endTimer()
			recordEventProcessing('payment_succeeded', 'success')
		} catch (error) {
			logger.error(
				{
					error: error.message,
					orderId: payload.orderId,
					correlationId,
				},
				'[Order] Error processing PAYMENT_SUCCEEDED'
			)
			endTimer()
			recordEventProcessing('payment_succeeded', 'failed')
			throw error
		}
	}

	/**
	 * Handle PAYMENT_FAILED event
	 * Includes compensation logic to release reserved inventory
	 */
	async handlePaymentFailed(payload, correlationId) {
		const endTimer = startEventProcessingTimer('payment_failed')
		logger.warn(
			{
				orderId: payload.orderId,
				reason: payload.reason,
				transactionId: payload.transactionId,
				correlationId,
			},
			'[Order] Processing PAYMENT_FAILED'
		)

		try {
			await withRetryTransaction(async (session) => {
				// Read order INSIDE transaction with session for proper locking
				const order = await orderRepository.findById(payload.orderId, session)
				if (!order) {
					logger.warn(
						{ orderId: payload.orderId, correlationId },
						'[Order] Order not found for PAYMENT_FAILED'
					)
					recordEventProcessing('payment_failed', 'skipped')
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
					recordEventProcessing('payment_failed', 'skipped')
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
					recordEventProcessing('payment_failed', 'failed')
					return
				}

				// Use state machine to validate transition: CONFIRMED → CANCELLED
				const oldStatus = order.status
				fsm.cancel()
				order.status = fsm.getState()

				// If status didn't change (idempotent), skip the rest
				if (oldStatus === order.status) {
					logger.info(
						{ orderId: order._id, status: order.status, correlationId },
						'[Order] Order already in target state, skipping (idempotent)'
					)
					recordEventProcessing('payment_failed', 'skipped')
					return
				}

				order.cancellationReason = payload.reason || 'Payment failed'
				await orderRepository.save(order, session)

				logger.info(
					{
						orderId: order._id,
						oldStatus,
						newStatus: order.status,
						cancellationReason: order.cancellationReason,
						transactionId: payload.transactionId,
						correlationId,
					},
					'[Order] Order status updated to CANCELLED (payment failed)'
				)

				// Record state transition and saga metrics
				recordStateTransition(oldStatus, 'CANCELLED', 'payment_failed')
				recordSagaOperation('order_flow', 'payment', 'failed')
				recordOrderValue(order.totalPrice, 'USD', 'cancelled')

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
							routingKey: 'order.release',
						})
						recordSagaOperation('order_flow', 'release', 'compensated')
					}
				}

				// Compensation: Release seckill slot if this is a seckill order
				const isSeckill = order.metadata?.source === 'seckill'
				if (isSeckill) {
					await this._publishSeckillRelease(order, session, correlationId, 'PAYMENT_FAILED')
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
					routingKey: 'order.cancelled',
				})
			}, { operationName: 'handlePaymentFailed' })

			endTimer()
			recordEventProcessing('payment_failed', 'success')
		} catch (error) {
			logger.error(
				{
					error: error.message,
					orderId: payload.orderId,
					correlationId,
				},
				'[Order] Error processing PAYMENT_FAILED'
			)
			endTimer()
			recordEventProcessing('payment_failed', 'failed')
			throw error
		}
	}

	/**
	 * Publish seckill release event for compensation
	 * Called when a seckill order is cancelled (either due to inventory or payment failure)
	 * 
	 * @private
	 * @param {Object} order - Order document
	 * @param {Object} session - MongoDB session
	 * @param {string} correlationId - Correlation ID for tracing
	 * @param {string} reason - Reason for release (e.g., 'PAYMENT_FAILED', 'INVENTORY_RESERVE_FAILED')
	 */
	async _publishSeckillRelease(order, session, correlationId, reason) {
		// For seckill orders, we need to release the slot back to Redis
		// so another user can purchase
		const productId = order.products[0]?._id?.toString()

		if (!productId) {
			logger.warn(
				{ orderId: order._id, correlationId },
				'[Order] Cannot publish seckill release: No product found in order'
			)
			return
		}

		await this.outboxManager.createEvent({
			eventType: 'SECKILL_RELEASE',
			payload: {
				orderId: order._id.toString(),
				userId: order.user,
				productId: productId,
				reason: reason,
			},
			session,
			correlationId,
			routingKey: 'order.seckill.release',
		})

		logger.info(
			{
				orderId: order._id,
				userId: order.user,
				productId,
				reason,
				correlationId,
			},
			'🔓 [Order] Published order.seckill.release event for compensation'
		)

		recordSagaOperation('order_flow', 'seckill_release', 'compensated')
	}
}

module.exports = OrderService
