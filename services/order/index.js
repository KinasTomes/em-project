// Initialize OpenTelemetry FIRST (before any other imports)
const { initTracing } = require('@ecommerce/tracing')

// Initialize tracing with service name and Jaeger endpoint
const jaegerEndpoint =
	process.env.JAEGER_ENDPOINT || 'http://localhost:4318/v1/traces'
initTracing('order-service', jaegerEndpoint)

// Now import other modules
const App = require('./src/app')
const logger = require('@ecommerce/logger')

const app = new App()

logger.info('Starting order service...')
app.start().catch((error) => {
	logger.error({ error: error.message }, 'Order service failed to start')
	process.exit(1)
})
