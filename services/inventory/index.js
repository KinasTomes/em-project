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
      logger.info(
        `⏳ [Inventory] Connecting to MongoDB... (Attempt ${i}/${retries})`
      );
      await mongoose.connect(config.mongoURI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
      });
      logger.info("✓ [Inventory] MongoDB connected");
      return;
    } catch (err) {
      logger.error(`✗ [Inventory] MongoDB connection failed: ${err.message}`);
      if (i < retries) {
        logger.info(`Retrying in ${delay / 1000} seconds...`);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        logger.error(
          "✗ [Inventory] Could not connect to MongoDB after all retries. Exiting."
        );
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
    // Connect to MongoDB
    await connectDB();

    // Event-driven broker disabled in synchronous mode
    // If needed in future, re-enable:
    // const messageBroker = require("./src/utils/messageBroker");
    // await messageBroker.connect();

    // Start Express server
    app.listen(PORT, () => {
      logger.info(`✓ [Inventory] Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(`✗ [Inventory] Failed to start server: ${error.message}`);
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
