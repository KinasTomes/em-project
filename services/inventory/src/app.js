const express = require('express')
const mongoose = require('mongoose')
const logger = require('@ecommerce/logger')
const config = require('./config')
const inventoryRoutes = require('./routes/inventoryRoutes')
const { registerInventoryConsumer } = require('./consumers/inventoryConsumer')

let Broker

class App {
	constructor() {
		this.app = express()
		this.server = null
		this.broker = null
	}

	setMiddlewares() {
		this.app.use(express.json())
		this.app.use(express.urlencoded({ extended: true }))

		// Request logging middleware
		this.app.use((req, res, next) => {
			logger.info(`${req.method} ${req.path}`)
			next()
		})
	}

	setRoutes() {
		// Health check endpoint
		this.app.get('/health', (req, res) => {
			res.status(200).json({
				status: 'healthy',
				service: 'inventory',
				timestamp: new Date().toISOString(),
			})
		})

		// API Routes
		this.app.use('/api/inventory', inventoryRoutes)

		// Error handling middleware
		this.app.use((err, req, res, next) => {
			logger.error(`Error: ${err.message}`)
			res.status(err.status || 500).json({
				message: err.message || 'Internal Server Error',
				...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
			})
		})

		// 404 handler
		this.app.use((req, res) => {
			res.status(404).json({ message: 'Route not found' })
		})
	}

	async connectDB(retries = 5, delay = 5000) {
		for (let i = 1; i <= retries; i++) {
			try {
				await mongoose.connect(config.mongoURI, {
					serverSelectionTimeoutMS: 30000,
					socketTimeoutMS: 45000,
				})
				logger.info({ mongoURI: config.mongoURI }, '✓ [Inventory] MongoDB connected')
				return
			} catch (err) {
				logger.error(
					{ error: err.message },
					`MongoDB connection failed (Attempt ${i}/${retries})`
				)
				if (i < retries) {
					await new Promise((res) => setTimeout(res, delay))
				} else {
					throw new Error('Could not connect to MongoDB after all retries')
				}
			}
		}
	}

	async disconnectDB() {
		await mongoose.connection.close()
		logger.info('✓ [Inventory] MongoDB disconnected')
	}

	async setupBroker() {
		const { Broker: BrokerClass } = await import('@ecommerce/message-broker')
		Broker = BrokerClass

		this.broker = new Broker()
		logger.info('✓ [Inventory] Broker initialized')

		// Register inventory consumer
		await registerInventoryConsumer(this.broker)
	}

	async start() {
		logger.info('Starting inventory service...')

		await this.connectDB()
		this.setMiddlewares()
		this.setRoutes()
		await this.setupBroker()

		this.server = this.app.listen(config.port, () => {
			logger.info({ port: config.port }, '✓ [Inventory] Server listening')
		})
	}

	async stop() {
		if (this.broker) {
			await this.broker.close()
			logger.info('✓ [Inventory] Broker connections closed')
		}

		await this.disconnectDB()

		if (this.server) {
			this.server.close()
			logger.info('✓ [Inventory] Server stopped')
		}
	}
}

module.exports = App
