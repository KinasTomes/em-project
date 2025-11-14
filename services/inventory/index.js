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
const inventoryService = require('./src/services/inventoryService')

const PORT = config.port

let broker = null

/**
 * Handle INVENTORY_RESERVE_REQUEST event
 */
async function handleReserveRequest(message, metadata = {}) {
	const { orderId, productId, quantity } = message
	const { eventId, correlationId } = metadata

	logger.info(
		{ orderId, productId, quantity, eventId, correlationId },
		'📦 [Inventory] Handling RESERVE request'
	)

	try {
		const result = await inventoryService.reserveStock(productId, quantity)

		if (result.success) {
			await broker.publish(
				'orders',
				{
					type: 'INVENTORY_RESERVED',
					data: {
						orderId,
						productId,
						quantity,
						timestamp: new Date().toISOString(),
					},
				},
				{ correlationId: orderId }
			)

			logger.info(
				{ orderId, productId, quantity },
				'✓ [Inventory] RESERVED - published to orders queue'
			)
		} else {
			await broker.publish(
				'orders',
				{
					type: 'INVENTORY_RESERVE_FAILED',
					data: {
						orderId,
						productId,
						reason: result.message,
						timestamp: new Date().toISOString(),
					},
				},
				{ correlationId: orderId }
			)

			logger.warn(
				{ orderId, productId, reason: result.message },
				'✗ [Inventory] RESERVE_FAILED - insufficient stock'
			)
		}
	} catch (error) {
		logger.error(
			{ error: error.message, orderId, productId },
			'❌ [Inventory] Error processing RESERVE request'
		)

		await broker.publish(
			'orders',
			{
				type: 'INVENTORY_RESERVE_FAILED',
				data: {
					orderId,
					productId,
					reason: error.message,
					timestamp: new Date().toISOString(),
				},
			},
			{ correlationId: orderId }
		)
	}
}

/**
 * Handle INVENTORY_RELEASE_REQUEST event
 */
async function handleReleaseRequest(message, metadata = {}) {
	const { orderId, productId, quantity } = message
	const { eventId, correlationId } = metadata

	logger.info(
		{ orderId, productId, quantity, eventId, correlationId },
		'🔓 [Inventory] Handling RELEASE request'
	)

	try {
		await inventoryService.releaseReserved(productId, quantity)

		await broker.publish(
			'orders',
			{
				type: 'INVENTORY_RELEASED',
				data: {
					orderId,
					productId,
					quantity,
					timestamp: new Date().toISOString(),
				},
			},
			{ correlationId: orderId }
		)

		logger.info(
			{ orderId, productId, quantity },
			'✓ [Inventory] RELEASED - published to orders queue'
		)
	} catch (error) {
		logger.error(
			{ error: error.message, orderId, productId },
			'❌ [Inventory] Error processing RELEASE request'
		)
	}
}

/**
 * Handle inventory events from RabbitMQ
 */
async function handleInventoryEvent(message, metadata = {}) {
	const { type } = message

	switch (type) {
		case 'INVENTORY_RESERVE_REQUEST':
			await handleReserveRequest(message.data, metadata)
			break
		case 'INVENTORY_RELEASE_REQUEST':
			await handleReleaseRequest(message.data, metadata)
			break
		default:
			logger.warn({ type }, '⚠️ [Inventory] Unknown event type')
	}
}

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
		await connectDB()

		// Connect to RabbitMQ broker using @ecommerce/message-broker
		const { Broker } = await import('@ecommerce/message-broker')
		broker = new Broker()
		logger.info('✓ [Inventory] Broker initialized')

		// Setup consumer for inventory queue
		await broker.consume('inventory', handleInventoryEvent)
		logger.info('✓ [Inventory] Consumer ready on "inventory" queue')
	} catch (error) {
		logger.error({ error: error.message }, 'Failed to start server')
		process.exit(1)
	}
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
	logger.info('SIGTERM signal received: closing HTTP server')
	await mongoose.connection.close()
	if (broker) {
		await broker.close()
	}
	process.exit(0)
})

process.on('SIGINT', async () => {
	logger.info('SIGINT signal received: closing HTTP server')
	await mongoose.connection.close()
	if (broker) {
		await broker.close()
	}
	process.exit(0)
})

startServer()
