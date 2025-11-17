const express = require("express");
const mongoose = require("mongoose");
const config = require("./config");
const { Broker } = require("@ecommerce/message-broker");
const productsRouter = require("./routes/productRoutes");
const logger = require("@ecommerce/logger");

class App {
  constructor() {
    this.app = express();
    this.broker = new Broker();
    this.connectDB();
    this.setMiddlewares();
    this.setRoutes();
  }

  async connectDB() {
    await mongoose.connect(config.mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✓ [Product] MongoDB connected");
    logger.info({ mongoURI: config.mongoURI }, "MongoDB connected");
  }

  async disconnectDB() {
    await mongoose.disconnect();
    console.log("MongoDB disconnected");
  }

  setMiddlewares() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
  }

  setRoutes() {
    // Inject broker into req so controllers can access it
    this.app.use((req, res, next) => {
      req.broker = this.broker;
      next();
    });
    this.app.use("/api/products", productsRouter);
  }

  start() {
    this.server = this.app.listen(config.port, () => {
      console.log(`✓ [Product] Server started on port ${config.port}`);
      console.log(`✓ [Product] Ready`);
      logger.info({ port: config.port }, "Product service ready");
    });
  }

  async stop() {
    await this.broker.close();
    await mongoose.disconnect();
    this.server.close();
    console.log("Server stopped");
  }
}

module.exports = App;
