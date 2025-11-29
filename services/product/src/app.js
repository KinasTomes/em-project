const express = require('express')
const mongoose = require('mongoose')
const config = require('./config')
const productsRouter = require('./routes/productRoutes')
const logger = require('@ecommerce/logger')

class App {
	constructor() {
		this.app = express()
		this.server = null
	}

	async connectDB() {
		await mongoose.connect(config.mongoURI)
		logger.info({ mongoURI: config.mongoURI }, '✓ [Product] MongoDB connected')
	}

	async disconnectDB() {
		await mongoose.disconnect()
		logger.info('✓ [Product] MongoDB disconnected')
	}

	setMiddlewares() {
		this.app.use(express.json())
		this.app.use(express.urlencoded({ extended: false }))
	}

	setRoutes() {
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
		this.setMiddlewares()
		this.setRoutes()

		this.server = this.app.listen(config.port, () => {
			logger.info({ port: config.port }, '✓ [Product] Server listening')
		})
	}

	async stop() {
		await this.disconnectDB()

		if (this.server) {
			this.server.close()
			logger.info('✓ [Product] Server stopped')
		}
	}
}

module.exports = App
