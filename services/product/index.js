// Initialize OpenTelemetry FIRST (before any other imports)
const { initTracing } = require("@ecommerce/tracing");

// Initialize tracing with service name and Jaeger endpoint
const jaegerEndpoint = process.env.JAEGER_ENDPOINT || "http://localhost:4318/v1/traces";
initTracing("product-service", jaegerEndpoint);

// Now import other modules
const App = require("./src/app");
const logger = require("@ecommerce/logger");

const app = new App();

// Graceful shutdown
process.on('SIGTERM', async () => {
	logger.info('SIGTERM received, shutting down gracefully...')
	await app.stop()
	process.exit(0)
})

process.on('SIGINT', async () => {
	logger.info('SIGINT received, shutting down gracefully...')
	await app.stop()
	process.exit(0)
})

// Start the application
app.start().catch((error) => {
	logger.error({ error: error.message }, '❌ Failed to start Product service')
	process.exit(1)
});