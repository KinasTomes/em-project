const express = require('express')
const logger = require('@ecommerce/logger')
const config = require('./config')
const createHealthRouter = require('./routes/healthRoutes')
const PaymentProcessor = require('./services/paymentProcessor')
const {
	registerStockReservedConsumer,
} = require('./consumers/stockReservedConsumer')

class App {
	constructor() {
		this.app = express()
		this.server = null
		this.broker = null
		this.paymentProcessor = new PaymentProcessor({
			successRate: config.payment.successRate,
		})
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

		await registerStockReservedConsumer({
			broker: this.broker,
			paymentProcessor: this.paymentProcessor,
			config,
		})
	}

	async start() {
		this.setMiddlewares()
		this.setRoutes()

		await this.setupBroker()

		this.server = this.app.listen(config.port, () => {
			logger.info({ port: config.port }, '✓ [Payment] HTTP server listening')
		})
	}

	async stop() {
		if (this.broker) {
			await this.broker.close()
			logger.info('✓ [Payment] Broker connections closed')
		}

		if (this.server) {
			this.server.close()
			logger.info('✓ [Payment] HTTP server stopped')
		}
	}
}

module.exports = App

