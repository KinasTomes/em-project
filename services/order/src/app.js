const express = require("express");
const mongoose = require("mongoose");
const Order = require("./models/order");
const config = require("./config");
const logger = require("@ecommerce/logger");
const { Broker } = require("@ecommerce/message-broker");
const OrderService = require("./services/orderService");
const OrderController = require("./controllers/orderController");
const orderRoutes = require("./routes/orderRoutes");

// Import Outbox Pattern (will use dynamic import for ES modules)
let OutboxManager;

class App {
  constructor() {
    this.app = express();
    this.broker = new Broker(); // 1. Create a single, reusable broker instance
    this.outboxManager = null;
    this.connectDB();
    this.setMiddlewares();
    this.initOutbox();
    this.setRoutes();
    this.setupOrderConsumer();
  }

  setMiddlewares() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
  }

  async initOutbox() {
    try {
      const { OutboxManager: OM } = await import("@ecommerce/outbox-pattern");
      OutboxManager = OM;
      
      this.outboxManager = new OutboxManager("order", mongoose.connection);
      logger.info("✓ [Order] OutboxManager initialized");
      
      await this.outboxManager.startProcessor();
      logger.info("✓ [Order] OutboxProcessor started");
    } catch (error) {
      logger.error({ error: error.message }, "Failed to initialize Outbox");
      throw error;
    }
  }

  setRoutes() {
    const orderService = new OrderService(this.broker, this.outboxManager);
    const orderController = new OrderController(orderService);
    this.app.use("/api/orders", orderRoutes(orderController));
  }

  async connectDB() {
    await mongoose.connect(config.mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✓ [Order] MongoDB connected");
    logger.info({ mongoURI: config.mongoURI }, "MongoDB connected");
  }

  async disconnectDB() {
    await mongoose.disconnect();
    console.log("MongoDB disconnected");
  }

  async _handleOrderEvent(data, metadata) {
    const { type, data: payload = {} } = data;
    const { eventId, correlationId } = metadata;

    logger.info({ eventId, correlationId, type }, "⚡ [Order] Received event...");

    try {
      switch (type) {
        case "INVENTORY_RESERVED":
          await this._handleInventoryReserved(payload, correlationId);
          break;
        case "INVENTORY_RESERVE_FAILED":
          await this._handleInventoryReserveFailed(payload, correlationId);
          break;
        case "PAYMENT_COMPLETED":
          await this._handlePaymentCompleted(payload, correlationId);
          break;
        case "PAYMENT_FAILED":
          await this._handlePaymentFailed(payload, correlationId);
          break;
        default:
          logger.warn({ type, correlationId }, "⚠️  [Order] Received unknown event type");
      }
    } catch (error) {
      logger.error({ error: error.message, eventId, type }, "❌ Error handling event");
      // Re-throw the error to allow the message broker to handle retry/DLQ
      throw error;
    }
  }

  async _handleInventoryReserved(payload, correlationId) {
    logger.info({ orderId: payload.orderId, correlationId }, "Processing INVENTORY_RESERVED");
    const order = await Order.findById(payload.orderId);
    if (!order) {
      logger.warn({ orderId: payload.orderId, correlationId }, "Order not found for INVENTORY_RESERVED");
      return;
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        let changed = false;
        order.products = order.products.map((p) => {
          if (p._id.toString() === payload.productId) {
            changed = true;
            return { ...p.toObject(), reserved: true };
          }
          return p;
        });

        if (changed) {
          const allReserved = order.products.every((p) => p.reserved === true);
          if (allReserved) {
            order.status = "CONFIRMED";
            await this.outboxManager.createEvent({
              eventType: "ORDER_CONFIRMED",
              payload: { orderId: order._id, timestamp: new Date().toISOString() },
              session,
              correlationId,
            });
          }
          await order.save({ session });
        }
      });
    } finally {
      session.endSession();
    }
  }

  async _handleInventoryReserveFailed(payload, correlationId) {
    logger.warn({ orderId: payload.orderId, reason: payload.reason, correlationId }, "Processing INVENTORY_RESERVE_FAILED");
    const order = await Order.findById(payload.orderId);
    if (!order) {
      logger.warn({ orderId: payload.orderId, correlationId }, "Order not found for INVENTORY_RESERVE_FAILED");
      return;
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        order.status = "CANCELLED";
        await order.save({ session });

        await this.outboxManager.createEvent({
          eventType: "ORDER_CANCELLED",
          payload: { orderId: order._id, reason: payload.reason, timestamp: new Date().toISOString() },
          session,
          correlationId,
        });
      });
    } finally {
      session.endSession();
    }
  }

  async _handlePaymentCompleted(payload, correlationId) {
    logger.info({ orderId: payload.orderId, correlationId }, "Processing PAYMENT_COMPLETED");
    const order = await Order.findById(payload.orderId);
    if (!order) {
      logger.warn({ orderId: payload.orderId, correlationId }, "Order not found for PAYMENT_COMPLETED");
      return;
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        order.status = "PAID";
        await order.save({ session });

        await this.outboxManager.createEvent({
          eventType: "ORDER_PAID",
          payload: { orderId: order._id, transactionId: payload.transactionId, timestamp: new Date().toISOString() },
          session,
          correlationId,
        });
      });
    } finally {
      session.endSession();
    }
  }

  async _handlePaymentFailed(payload, correlationId) {
    logger.warn({ orderId: payload.orderId, reason: payload.reason, correlationId }, "Processing PAYMENT_FAILED");
    const order = await Order.findById(payload.orderId);
    if (!order) {
      logger.warn({ orderId: payload.orderId, correlationId }, "Order not found for PAYMENT_FAILED");
      return;
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        order.status = "CANCELLED";
        await order.save({ session });

        // Compensation: Release inventory
        for (const product of order.products) {
          if(product.reserved) {
            await this.outboxManager.createEvent({
              eventType: "RELEASE",
              payload: { orderId: order._id, productId: product._id.toString(), quantity: product.quantity, reason: "PAYMENT_FAILED" },
              session,
              correlationId,
            });
          }
        }

        await this.outboxManager.createEvent({
          eventType: "ORDER_CANCELLED",
          payload: { orderId: order._id, reason: `Payment failed: ${payload.reason}`, timestamp: new Date().toISOString() },
          session,
          correlationId,
        });
      });
    } finally {
      session.endSession();
    }
  }

  async setupOrderConsumer() {
    try {
      logger.info("⏳ [Order] Setting up event consumer using @ecommerce/message-broker...");
      // Use the single broker instance. The broker handles connections and retries internally.
      await this.broker.consume("orders", this._handleOrderEvent.bind(this));
      logger.info("✓ [Order] Event consumer setup complete and is waiting for messages.");
    } catch (err) {
      logger.error({ error: err.message }, "❌ Fatal: Could not setup event consumer.");
      // In a real app, you might want to exit if the consumer is critical
      // process.exit(1); 
    }
  }

  start() {
    this.server = this.app.listen(config.port, () => {
      console.log(`✓ [Order] Server started on port ${config.port}`);
      console.log(`✓ [Order] Ready`);
      logger.info({ port: config.port }, "Order service ready");
    });
  }

  async stop() {
    if (this.broker) {
      await this.broker.close();
      logger.info("✓ [Order] MessageBroker connections closed");
    }
    if (this.outboxManager) {
      await this.outboxManager.stopProcessor();
    }
    await this.disconnectDB();
    if (this.server) {
      this.server.close();
      console.log("Server stopped");
    }
  }
}

module.exports = App;
