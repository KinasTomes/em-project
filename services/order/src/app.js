const express = require('express')
const mongoose = require('mongoose')
const config = require('./config')
const logger = require('@ecommerce/logger')
const { metricsMiddleware, metricsHandler } = require('@ecommerce/metrics')
const OrderService = require('./services/orderService')
const IdempotencyService = require('./services/idempotencyService')
const OrderController = require('./controllers/orderController')
const orderRoutes = require('./routes/orderRoutes')
const { registerOrderEventsConsumer } = require('./consumers/orderEventsConsumer')

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
		this.idempotencyService = new IdempotencyService(config.redisUrl)
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
		
		// Register routes
		this.app.use('/api/orders', orderRoutes(orderController))
		
		// Health check routes (includes circuit breaker monitoring)
		const healthRoutes = require('./routes/healthRoutes')
		this.app.use('/api', healthRoutes)
	}

	async connectDB() {
		await mongoose.connect(config.mongoURI)
		logger.info({ mongoURI: config.mongoURI }, '✓ [Order] MongoDB connected')
	}

	async disconnectDB() {
		await mongoose.disconnect()
		logger.info('✓ [Order] MongoDB disconnected')
	}

	async setupBroker() {
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

			// Initialize idempotency service
			await this.idempotencyService.connect()

			// Register order events consumer with idempotency
			await registerOrderEventsConsumer({
				broker: this.broker,
				orderService: this.orderService,
				idempotencyService: this.idempotencyService,
				config,
			})
		} catch (error) {
			logger.error(
				{ error: error.message },
				'❌ Fatal: Unable to setup event consumer'
			)
			throw error
		}
	}

	async start() {
		await this.connectDB()
		this.setMiddlewares()
		await this.initOutbox()
		this.setRoutes()
		await this.setupBroker()

		this.server = this.app.listen(config.port, () => {
			logger.info({ port: config.port }, '✓ [Order] Server listening')
		})
	}

	async stop() {
		if (this.idempotencyService) {
			await this.idempotencyService.close()
			logger.info('✓ [Order] Idempotency service closed')
		}

		if (this.broker) {
			await this.broker.close()
			logger.info('✓ [Order] Broker connections closed')
		}

		if (this.outboxManager) {
			await this.outboxManager.stopProcessor()
			logger.info('✓ [Order] Outbox processor stopped')
		}

		// Shutdown circuit breaker
		const { productClient } = require('./clients/productClient')
		productClient.shutdown()
		logger.info('✓ [Order] Circuit breaker shutdown')

		await this.disconnectDB()

		if (this.server) {
			this.server.close()
			logger.info('✓ [Order] Server stopped')
		}
	}
}

module.exports = App
