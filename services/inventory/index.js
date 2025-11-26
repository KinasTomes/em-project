// Initialize OpenTelemetry FIRST (before any other imports)
const { initTracing } = require('@ecommerce/tracing')

// Initialize tracing with service name and Jaeger endpoint
const jaegerEndpoint =
	process.env.JAEGER_ENDPOINT || 'http://localhost:4318/v1/traces'
initTracing('inventory-service', jaegerEndpoint)

// Now import other modules
const App = require('./src/app')
const logger = require('@ecommerce/logger')

const app = new App()

// Handle graceful shutdown
process.on('SIGTERM', async () => {
	logger.info('SIGTERM signal received: closing server')
	await app.stop()
	process.exit(0)
})

process.on('SIGINT', async () => {
	logger.info('SIGINT signal received: closing server')
	await app.stop()
	process.exit(0)
})

logger.info('Starting inventory service...')
app.start().catch((error) => {
	logger.error({ error: error.message }, 'Inventory service failed to start')
	process.exit(1)
})
