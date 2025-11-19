const express = require('express')
const mongoose = require('mongoose')
const config = require('./config')
const logger = require('@ecommerce/logger')
const Order = require('./models/order')
const OrderService = require('./services/orderService')
const OrderController = require('./controllers/orderController')
const orderRoutes = require('./routes/orderRoutes')

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
				case 'PAYMENT_COMPLETED':
					await this._handlePaymentCompleted(payload, correlationId)
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
			{ orderId: payload.orderId, correlationId },
			'Processing INVENTORY_RESERVED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'Order not found for INVENTORY_RESERVED'
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
						order.status = 'CONFIRMED'
						await this.outboxManager.createEvent({
							eventType: 'ORDER_CONFIRMED',
							payload: {
								orderId: order._id,
								timestamp: new Date().toISOString(),
							},
							session,
							correlationId,
						})
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
			{ orderId: payload.orderId, reason: payload.reason, correlationId },
			'Processing INVENTORY_RESERVE_FAILED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'Order not found for INVENTORY_RESERVE_FAILED'
			)
			return
		}

		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				order.status = 'CANCELLED'
				await order.save({ session })

				await this.outboxManager.createEvent({
					eventType: 'ORDER_CANCELLED',
					payload: {
						orderId: order._id,
						reason: payload.reason,
						timestamp: new Date().toISOString(),
					},
					session,
					correlationId,
				})
			})
		} finally {
			session.endSession()
		}
	}

	async _handlePaymentCompleted(payload, correlationId) {
		logger.info(
			{ orderId: payload.orderId, correlationId },
			'Processing PAYMENT_COMPLETED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'Order not found for PAYMENT_COMPLETED'
			)
			return
		}

		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				order.status = 'PAID'
				await order.save({ session })

				await this.outboxManager.createEvent({
					eventType: 'ORDER_PAID',
					payload: {
						orderId: order._id,
						transactionId: payload.transactionId,
						timestamp: new Date().toISOString(),
					},
					session,
					correlationId,
				})
			})
		} finally {
			session.endSession()
		}
	}

	async _handlePaymentFailed(payload, correlationId) {
		logger.warn(
			{ orderId: payload.orderId, reason: payload.reason, correlationId },
			'Processing PAYMENT_FAILED'
		)

		const order = await Order.findById(payload.orderId)
		if (!order) {
			logger.warn(
				{ orderId: payload.orderId, correlationId },
				'Order not found for PAYMENT_FAILED'
			)
			return
		}

		const session = await mongoose.startSession()
		try {
			await session.withTransaction(async () => {
				order.status = 'CANCELLED'
				await order.save({ session })

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
						reason: `Payment failed: ${payload.reason}`,
						timestamp: new Date().toISOString(),
					},
					session,
					correlationId,
				})
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
