const express = require('express')
const mongoose = require('mongoose')
const config = require('./config')
const productsRouter = require('./routes/productRoutes')
const logger = require('@ecommerce/logger')
const { metricsMiddleware, metricsHandler } = require('@ecommerce/metrics')
const cacheService = require('./services/cacheService')

class App {
	constructor() {
		this.app = express()
		this.server = null
	}

	async connectDB() {
		await mongoose.connect(config.mongoURI)
		logger.info({ mongoURI: config.mongoURI }, '✓ [Product] MongoDB connected')
	}

	async connectCache() {
		try {
			await cacheService.connect()
			logger.info('✓ [Product] Redis cache connected')
		} catch (error) {
			// Cache is optional - service can work without it
			logger.warn({ error: error.message }, '⚠️ [Product] Redis cache unavailable, running without cache')
		}
	}

	async disconnectDB() {
		await mongoose.disconnect()
		logger.info('✓ [Product] MongoDB disconnected')
	}

	setMiddlewares() {
		// Metrics middleware (must be early in chain)
		this.app.use(metricsMiddleware('product-service'))
		
		this.app.use(express.json())
		this.app.use(express.urlencoded({ extended: false }))
	}

	setRoutes() {
		// Metrics endpoint
		this.app.get('/metrics', metricsHandler)

		// Health check endpoint
		this.app.get('/health', (req, res) => {
			res.status(200).json({
				status: 'healthy',
				service: 'product',
				timestamp: new Date().toISOString(),
			})
		})

		this.app.use('/api/products', productsRouter)
	}

	async start() {
		await this.connectDB()
		await this.connectCache()
		this.setMiddlewares()
		this.setRoutes()

		this.server = this.app.listen(config.port, () => {
			logger.info({ 
				port: config.port,
				cache: cacheService.isAvailable() ? 'enabled' : 'disabled'
			}, '✓ [Product] Server listening')
		})
	}

	async stop() {
		await this.disconnectDB()
		await cacheService.close()

		if (this.server) {
			this.server.close()
			logger.info('✓ [Product] Server stopped')
		}
	}
}

module.exports = App
