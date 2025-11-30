const express = require("express");
const mongoose = require("mongoose");
const config = require("./config");
const authMiddleware = require("./middlewares/authMiddleware");
const AuthController = require("./controllers/authController");
const logger = require("@ecommerce/logger");
const { metricsMiddleware, metricsHandler } = require("@ecommerce/metrics");

class App {
  constructor() {
    this.app = express();
    this.authController = new AuthController();
    this.connectDB();
    this.setMiddlewares();
    this.setRoutes();
  }

  async connectDB() {
    await mongoose.connect(config.mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info({ mongoURI: config.mongoURI }, "✓ [Auth] MongoDB connected");
  }

  async disconnectDB() {
    await mongoose.disconnect();
    logger.info("MongoDB disconnected");
  }

  setMiddlewares() {
    // Metrics middleware (must be early in chain)
    this.app.use(metricsMiddleware("auth-service"));
    
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
  }

  setRoutes() {
    // Metrics endpoint
    this.app.get("/metrics", metricsHandler);

    this.app.post("/login", (req, res) => this.authController.login(req, res));
    this.app.post("/register", (req, res) => this.authController.register(req, res));
    this.app.get("/dashboard", authMiddleware, (req, res) => res.json({ message: "Welcome to dashboard" }));
  }

  start() {
    this.server = this.app.listen(config.port, () => {
      logger.info({ port: config.port }, "✓ [Auth] Server started");
      logger.info("✓ [Auth] Ready");
    });
  }

  async stop() {
    logger.info("Graceful shutdown initiated...");
    
    // Stop accepting new connections
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close((err) => {
          if (err) {
            logger.error({ error: err.message }, "Error closing server");
          } else {
            logger.info("HTTP server closed");
          }
          resolve();
        });
      });
    }
    
    // Close database connection
    await mongoose.disconnect();
    logger.info("MongoDB disconnected");
    logger.info("✓ [Auth] Server stopped gracefully");
  }

  setupGracefulShutdown() {
    const signals = ['SIGTERM', 'SIGINT'];
    
    signals.forEach((signal) => {
      process.on(signal, async () => {
        logger.info({ signal }, `Received ${signal}, starting graceful shutdown...`);
        try {
          await this.stop();
          process.exit(0);
        } catch (error) {
          logger.error({ error: error.message }, "Error during graceful shutdown");
          process.exit(1);
        }
      });
    });
  }
}

module.exports = App;
