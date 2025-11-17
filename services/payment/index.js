// Initialize OpenTelemetry tracing before anything else
const { initTracing } = require('@ecommerce/tracing')

const jaegerEndpoint =
	process.env.JAEGER_ENDPOINT || 'http://localhost:4318/v1/traces'
initTracing('payment-service', jaegerEndpoint)

const logger = require('@ecommerce/logger')
const App = require('./src/app')

async function bootstrap() {
	const app = new App()

	try {
		logger.info('🚀 [Payment] Starting service...')
		await app.start()
	} catch (error) {
		logger.error({ error: error.message }, '❌ [Payment] Failed to start')
		process.exit(1)
	}
}

bootstrap()

