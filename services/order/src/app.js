const express = require('express')
const mongoose = require('mongoose')
const config = require('./config')
const logger = require('@ecommerce/logger')
const Order = require('./models/order')
const OrderService = require('./services/orderService')
const OrderController = require('./controllers/orderController')
const orderRoutes = require('./routes/orderRoutes')
const { createOrderStateMachine } = require('./services/orderStateMachine')

// Import ES modules dynamically
let OutboxManager
let Broker

class App {
	constructor() {
		this.app = express()
		this.outboxManager = null
		this.broker = null
		this.server = null
	}

	setMiddlewares() {
		this.app.use(express.json())
		this.app.use(express.urlencoded({ extended: false }))
	}

	async initOutbox() {
		try {
			const { OutboxManager: OM } = await import('@ecommerce/outbox-pattern')
			OutboxManager = OM

			this.outboxManager = new OutboxManager('order', mongoose.connection)
			logger.info('✓ [Order] OutboxManager initialized')

			await this.outboxManager.startProcessor()
			logger.info('✓ [Order] OutboxProcessor started')
		} catch (error) {
			logger.error({ error: error.message }, 'Failed to initialize Outbox')
			throw error
		}
	}

	setRoutes() {
		if (!this.outboxManager) {
			throw new Error('OutboxManager not initialized')
		}

		const orderService = new OrderService(this.outboxManager)
		const orderController = new OrderController(orderService)
		this.app.use('/api/orders', orderRoutes(orderController))
	}

	async connectDB() {
		await mongoose.connect(config.mongoURI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		})
		logger.info({ mongoURI: config.mongoURI }, '✓ [Order] MongoDB connected')
	}

	async disconnectDB() {
		await mongoose.disconnect()
		logger.info('✓ [Order] MongoDB disconnected')
	}

	async _handleOrderEvent(message, metadata = {}) {
		const { type, data: payload = {} } = message
		const { eventId, correlationId } = metadata

		logger.info({ eventId, correlationId, type }, '⚡ [Order] Received event')

		try {
			switch (type) {
				case 'INVENTORY_RESERVED':
					await this._handleInventoryReserved(payload, correlationId)
					break
				case 'INVENTORY_RESERVE_FAILED':
					await this._handleInventoryReserveFailed(payload, correlationId)
					break
				case 'PAYMENT_SUCCEEDED':
					await this._handlePaymentSucceeded(payload, correlationId)
					break
				case 'PAYMENT_COMPLETED':
					// Backward compatibility - treat as PAYMENT_SUCCEEDED
					await this._handlePaymentSucceeded(payload, correlationId)
					break
				case 'PAYMENT_FAILED':
					await this._handlePaymentFailed(payload, correlationId)
					break
				default:
					logger.warn({ type, correlationId }, '⚠️ [Order] Unknown event type')
			}
		} catch (error) {
			logger.error(
				{ error: error.message, eventId, type },
				'❌ Error handling event'
			)
			throw error
		}
	}

	async _handleInventoryReserved(payload, correlationId) {
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

	async _handleInventoryReserveFailed(payload, correlationId) {
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

	async _handlePaymentSucceeded(payload, correlationId) {
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
				// Order must be CONFIRMED (inventory reserved) before payment
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

	async _handlePaymentFailed(payload, correlationId) {
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

		// Validate that order is in CONFIRMED state (payment can only fail if order was confirmed)
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

	async setupOrderConsumer() {
		try {
			logger.info(
				'⏳ [Order] Setting up event consumer using @ecommerce/message-broker'
			)

			// Dynamically import Broker (ES module)
			const { Broker: BrokerClass } = await import('@ecommerce/message-broker')
			Broker = BrokerClass

			// Initialize Broker (no connect() needed - lazy connection)
			this.broker = new Broker()
			logger.info('✓ [Order] Broker initialized')

			await this.broker.consume('orders', this._handleOrderEvent.bind(this))
			logger.info('✓ [Order] Event consumer ready')
		} catch (error) {
			logger.error(
				{ error: error.message },
				'❌ Fatal: Unable to setup event consumer'
			)
		}
	}
	async start() {
		await this.connectDB()
		this.setMiddlewares()
		await this.initOutbox()
		this.setRoutes()
		await this.setupOrderConsumer()

		this.server = this.app.listen(config.port, () => {
			logger.info({ port: config.port }, '✓ [Order] Server listening')
		})
	}

	async stop() {
		if (this.broker) {
			await this.broker.close()
			logger.info('✓ [Order] Broker connections closed')
		}

		if (this.outboxManager) {
			await this.outboxManager.stopProcessor()
			logger.info('✓ [Order] Outbox processor stopped')
		}

		await this.disconnectDB()

		if (this.server) {
			this.server.close()
			logger.info('✓ [Order] Server stopped')
		}
	}
}

module.exports = App
