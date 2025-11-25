// Initialize OpenTelemetry FIRST (before any other imports)
const { initTracing } = require('@ecommerce/tracing')

// Initialize tracing with service name and Jaeger endpoint
const jaegerEndpoint =
	process.env.JAEGER_ENDPOINT || 'http://localhost:4318/v1/traces'
initTracing('inventory-service', jaegerEndpoint)

// Load config BEFORE logger to ensure NODE_ENV is set
require('@ecommerce/config')

// Now import other modules
const app = require('./src/app')
const config = require('./src/config')
const mongoose = require('mongoose')
const logger = require('@ecommerce/logger')
const { registerInventoryConsumer } = require('./src/consumers/inventoryConsumer')
const InventoryOutboxProcessor = require('./src/processors/outboxProcessor')

const PORT = config.port

let broker = null
let outboxProcessor = null


/**
 * Connect to MongoDB with retry logic
 */
async function connectDB(retries = 5, delay = 5000) {
	for (let i = 1; i <= retries; i++) {
		try {
			await mongoose.connect(config.mongoURI, {
				serverSelectionTimeoutMS: 30000,
				socketTimeoutMS: 45000,
			})
			console.log('✓ [Inventory] MongoDB connected')
			logger.info({ mongoURI: config.mongoURI }, 'MongoDB connected')
			return
		} catch (err) {
			logger.error(
				{ error: err.message },
				`MongoDB connection failed (Attempt ${i}/${retries})`
			)
			if (i < retries) {
				await new Promise((res) => setTimeout(res, delay))
			} else {
				logger.error('Could not connect to MongoDB after all retries. Exiting.')
				process.exit(1)
			}
		}
	}
}

/**
 * Start the server
 */
async function startServer() {
	try {
		logger.info('Starting inventory service...')

		// Start Express server first
		app.listen(PORT, () => {
			console.log(`✓ [Inventory] Server started on port ${PORT}`)
			console.log('✓ [Inventory] Ready')
			logger.info({ port: PORT }, 'Inventory service ready')
		})

		// Connect to MongoDB
		await connectDB();
		
		// Connect to RabbitMQ broker and register consumer
		const { Broker } = await import('@ecommerce/message-broker')
		broker = new Broker()
		logger.info('✓ [Inventory] Broker initialized')

		// Initialize and start Outbox Processor
		outboxProcessor = new InventoryOutboxProcessor(broker)
		await outboxProcessor.start()
		logger.info('✓ [Inventory] Outbox processor started')

		// Register inventory consumer
		await registerInventoryConsumer(broker)
	} catch (error) {
		logger.error({ error: error.message }, 'Failed to start server')
		process.exit(1)
	}
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
	logger.info('SIGTERM signal received: closing HTTP server')
	if (outboxProcessor) {
		await outboxProcessor.stop()
		logger.info('✓ [Inventory] Outbox processor stopped')
	}
	await mongoose.connection.close()
	if (broker) {
		await broker.close()
	}
	process.exit(0)
})

process.on('SIGINT', async () => {
	logger.info('SIGINT signal received: closing HTTP server')
	if (outboxProcessor) {
		await outboxProcessor.stop()
		logger.info('✓ [Inventory] Outbox processor stopped')
	}
	await mongoose.connection.close()
	if (broker) {
		await broker.close()
	}
	process.exit(0)
})

startServer()
