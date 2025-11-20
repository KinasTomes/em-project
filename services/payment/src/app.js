const express = require('express')
const mongoose = require('mongoose')
const logger = require('@ecommerce/logger')
const config = require('./config')
const createHealthRouter = require('./routes/healthRoutes')
const PaymentProcessor = require('./services/paymentProcessor')
const IdempotencyService = require('./services/idempotencyService')
const PaymentService = require('./services/paymentService')
const {
	registerOrderConfirmedConsumer,
} = require('./consumers/orderConfirmedConsumer')

class App {
	constructor() {
		this.app = express()
		this.server = null
		this.broker = null
		this.paymentProcessor = new PaymentProcessor({
			successRate: config.payment.successRate,
		})
		this.idempotencyService = new IdempotencyService(config.redisUrl)
		this.paymentService = new PaymentService()
	}

	async connectDB() {
		await mongoose.connect(config.mongoURI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		})
		logger.info({ mongoURI: config.mongoURI }, '✓ [Payment] MongoDB connected')
	}

	async disconnectDB() {
		await mongoose.disconnect()
		logger.info('✓ [Payment] MongoDB disconnected')
	}

	setMiddlewares() {
		this.app.use(express.json())
		this.app.use(express.urlencoded({ extended: false }))
	}

	setRoutes() {
		this.app.use('/health', createHealthRouter())
		this.app.get('/', (_req, res) => {
			res.json({ service: 'payment', status: 'ok' })
		})
	}

	async setupBroker() {
		const { Broker } = await import('@ecommerce/message-broker')
		this.broker = new Broker()

		// Initialize idempotency service
		await this.idempotencyService.connect()

		// Register ORDER_CONFIRMED consumer
		await registerOrderConfirmedConsumer({
			broker: this.broker,
			paymentProcessor: this.paymentProcessor,
			config,
			idempotencyService: this.idempotencyService,
			paymentService: this.paymentService,
		})
	}

	async start() {
		await this.connectDB()
		this.setMiddlewares()
		this.setRoutes()

		await this.setupBroker()

		this.server = this.app.listen(config.port, () => {
			logger.info({ port: config.port }, '✓ [Payment] HTTP server listening')
		})
	}

	async stop() {
		if (this.idempotencyService) {
			await this.idempotencyService.close()
			logger.info('✓ [Payment] Idempotency service closed')
		}

		if (this.broker) {
			await this.broker.close()
			logger.info('✓ [Payment] Broker connections closed')
		}

		await this.disconnectDB()

		if (this.server) {
			this.server.close()
			logger.info('✓ [Payment] HTTP server stopped')
		}
	}
}

module.exports = App

