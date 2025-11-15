// Initialize OpenTelemetry FIRST (before any other imports)
const { initTracing } = require("@ecommerce/tracing");

// Initialize tracing with service name and Jaeger endpoint
const jaegerEndpoint = process.env.JAEGER_ENDPOINT || "http://localhost:4318/v1/traces";
initTracing("inventory-service", jaegerEndpoint);

// Load config BEFORE logger to ensure NODE_ENV is set
require("@ecommerce/config");

// Now import other modules
const app = require("./src/app");
const config = require("./src/config");
const mongoose = require("mongoose");
const logger = require("@ecommerce/logger");

const PORT = config.port;

/**
 * Connect to MongoDB with retry logic
 */
async function connectDB(retries = 5, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await mongoose.connect(config.mongoURI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
      });
      console.log("✓ [Inventory] MongoDB connected");
      logger.info({ mongoURI: config.mongoURI }, "MongoDB connected");
      return;
    } catch (err) {
      logger.error({ error: err.message }, `MongoDB connection failed (Attempt ${i}/${retries})`);
      if (i < retries) {
        await new Promise((res) => setTimeout(res, delay));
      } else {
        logger.error("Could not connect to MongoDB after all retries. Exiting.");
        process.exit(1);
      }
    }
  }
}

/**
 * Start the server
 */
async function startServer() {
  try {
    // Log starting message (OUTSIDE callback like auth service)
    logger.info("Starting inventory service...");

    // Start Express server first (like other services)
    app.listen(PORT, () => {
      console.log(`✓ [Inventory] Server started on port ${PORT}`);
      console.log(`✓ [Inventory] Ready`);
      logger.info({ port: PORT }, "Inventory service ready");
    });

    // Connect to MongoDB
    await connectDB();

    // Enable event-driven processing: consume RabbitMQ inventory events
    const messageBroker = require("./src/utils/messageBroker");
    await messageBroker.connect();
  } catch (error) {
    logger.error({ error: error.message }, "Failed to start server");
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  await mongoose.connection.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT signal received: closing HTTP server");
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
