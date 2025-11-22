const express = require('express')
const mongoose = require('mongoose')
const config = require('./config')
const logger = require('@ecommerce/logger')
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
		this.orderService = null
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

		// Initialize orderService as instance variable for use in event handlers
		this.orderService = new OrderService(this.outboxManager)
		const orderController = new OrderController(this.orderService)
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

		if (!this.orderService) {
			logger.error('OrderService not initialized')
			throw new Error('OrderService not initialized')
		}

		try {
			switch (type) {
				case 'INVENTORY_RESERVED_SUCCESS':
					await this.orderService.handleInventoryReserved(payload, correlationId)
					break
				case 'INVENTORY_RESERVED_FAILED':
					await this.orderService.handleInventoryReserveFailed(payload, correlationId)
					break
				case 'PAYMENT_SUCCEEDED':
					await this.orderService.handlePaymentSucceeded(payload, correlationId)
					break
				case 'PAYMENT_COMPLETED':
					// Backward compatibility - treat as PAYMENT_SUCCEEDED
					await this.orderService.handlePaymentSucceeded(payload, correlationId)
					break
				case 'PAYMENT_FAILED':
					await this.orderService.handlePaymentFailed(payload, correlationId)
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

			// Consume from Order Service's dedicated queue with routing keys
			const queueName = 'q.order-service'
			const routingKeys = [
				'inventory.reserved.success', // INVENTORY_RESERVED_SUCCESS
				'inventory.reserved.failed',  // INVENTORY_RESERVED_FAILED
				'payment.succeeded',       // PAYMENT_SUCCEEDED
				'payment.failed'           // PAYMENT_FAILED
			]

			await this.broker.consume(
				queueName,
				this._handleOrderEvent.bind(this),
				null, // No schema validation at broker level
				routingKeys
			)
			logger.info({ queue: queueName, routingKeys }, '✓ [Order] Event consumer ready')
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
