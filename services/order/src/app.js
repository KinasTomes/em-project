const express = require("express");
const mongoose = require("mongoose");
const Order = require("./models/order");
const config = require("./config");
const logger = require("@ecommerce/logger");
const OrderService = require("./services/orderService");
const OrderController = require("./controllers/orderController");
const orderRoutes = require("./routes/orderRoutes");

// Import Outbox Pattern and MessageBroker (will use dynamic import for ES modules)
let OutboxManager;
let Broker;

class App {
  constructor() {
    this.app = express();
    this.messageBroker = null;
    this.outboxManager = null;
    this.connectDB();
    this.setMiddlewares();
    this.initMessageBroker();
    this.initOutbox();
    this.setRoutes();
    this.setupOrderConsumer();
  }

  setMiddlewares() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
  }

  async initMessageBroker() {
    try {
      // Dynamic import for ES module
      const { Broker: BrokerClass } = await import("@ecommerce/message-broker");
      Broker = BrokerClass;
      
      this.messageBroker = new Broker();
      logger.info("✓ [Order] MessageBroker initialized (connections lazy-loaded)");
    } catch (error) {
      logger.error({ error: error.message }, "Failed to initialize MessageBroker");
      throw error;
    }
  }

  async initOutbox() {
    try {
      // Dynamic import for ES module
      const { OutboxManager: OM } = await import("@ecommerce/outbox-pattern");
      OutboxManager = OM;
      
      this.outboxManager = new OutboxManager("order", mongoose.connection);
      logger.info("✓ [Order] OutboxManager initialized");
      
      // Start processor after MongoDB is connected
      await this.outboxManager.startProcessor();
      logger.info("✓ [Order] OutboxProcessor started");
    } catch (error) {
      logger.error({ error: error.message }, "Failed to initialize Outbox");
      throw error;
    }
  }

  setRoutes() {
    // Initialize service and controller with outboxManager
    const orderService = new OrderService(this.messageBroker, this.outboxManager);
    const orderController = new OrderController(orderService);

    // Mount routes
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

  /**
   * Handle order events from other services
   * @private
   */
  async _handleOrderEvent(type, payload, correlationId) {
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
        console.warn(`⚠️  [Order] Unknown event type: ${type}`);
        logger.warn({ type, correlationId }, "Received unknown event type");
    }
  }

  /**
   * Handle INVENTORY_RESERVED event
   * @private
   */
  async _handleInventoryReserved(payload, correlationId) {
    console.log(
      `✓ [Order] Inventory reserved for order ${payload.orderId}`
    );
    logger.info(
      { orderId: payload.orderId, correlationId },
      "Inventory reserved successfully"
    );
    
    try {
      const orderId = payload.orderId;
      const productId = payload.productId;
      const order = await Order.findById(orderId);
      
      if (order) {
        // Use MongoDB Transaction for atomicity
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          // Mark product as reserved
          let changed = false;
          order.products = order.products.map((p) => {
            if (p._id.toString() === productId) {
              changed = true;
              return { ...p.toObject(), reserved: true };
            }
            return p;
          });

          // If all products reserved, mark CONFIRMED
          const allReserved = order.products.every(
            (p) => p.reserved === true
          );
          
          if (allReserved) {
            order.status = "CONFIRMED";
            
            // Save order
            if (changed) {
              await order.save({ session });
            }

            // Use Outbox Pattern to publish ORDER_CONFIRMED
            if (this.outboxManager) {
              await this.outboxManager.createEvent({
                eventType: "ORDER_CONFIRMED",
                payload: {
                  orderId,
                  timestamp: new Date().toISOString()
                },
                session,
                correlationId: correlationId || orderId
              });
              logger.info(
                { orderId, correlationId },
                "Order confirmed, event saved to outbox"
              );
            }
          } else {
            // Just save the reservation status
            if (changed) {
              await order.save({ session });
            }
          }

          await session.commitTransaction();
          logger.info({ orderId, productId, correlationId }, "Order updated successfully");
          
        } catch (txError) {
          await session.abortTransaction();
          logger.error(
            { error: txError.message, orderId, correlationId },
            "Transaction failed, rolled back"
          );
        } finally {
          session.endSession();
        }
      } else {
        logger.warn(
          { orderId: payload.orderId, correlationId },
          "Order not found to update reservation"
        );
      }
    } catch (err) {
      logger.error(
        { err: err.message, correlationId },
        "Error updating order reservation status"
      );
    }
  }

  /**
   * Handle INVENTORY_RESERVE_FAILED event
   * @private
   */
  async _handleInventoryReserveFailed(payload, correlationId) {
    console.log(
      `✗ [Order] Inventory reserve failed for order ${payload.orderId}`
    );
    logger.warn(
      { orderId: payload.orderId, reason: payload.reason, correlationId },
      "Inventory reservation failed"
    );
    
    try {
      const orderId = payload.orderId;
      const order = await Order.findById(orderId);
      
      if (order) {
        // Use MongoDB Transaction for atomicity
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          // Cancel order
          order.status = "CANCELLED";
          await order.save({ session });

          // Release any previously reserved items (compensation)
          const reservedProducts = order.products.filter((pp) => pp.reserved);
          
          if (reservedProducts.length > 0 && this.outboxManager) {
            for (const p of reservedProducts) {
              await this.outboxManager.createEvent({
                eventType: "RELEASE",
                payload: {
                  orderId,
                  productId: p._id.toString(),
                  quantity: p.quantity || 1,
                  reason: "ORDER_CANCELLED"
                },
                session,
                correlationId: correlationId || orderId
              });
            }
            logger.info(
              { orderId, releasedCount: reservedProducts.length, correlationId },
              "RELEASE compensation events saved to outbox"
            );
          }

          // Publish ORDER_CANCELLED event
          if (this.outboxManager) {
            await this.outboxManager.createEvent({
              eventType: "ORDER_CANCELLED",
              payload: {
                orderId,
                reason: payload.reason,
                timestamp: new Date().toISOString()
              },
              session,
              correlationId: correlationId || orderId
            });
            logger.info(
              { orderId, reason: payload.reason, correlationId },
              "ORDER_CANCELLED event saved to outbox"
            );
          }

          await session.commitTransaction();
          logger.info({ orderId, correlationId }, "Order cancelled successfully");
          
        } catch (txError) {
          await session.abortTransaction();
          logger.error(
            { error: txError.message, orderId, correlationId },
            "Transaction failed, rolled back"
          );
        } finally {
          session.endSession();
        }
      } else {
        logger.warn(
          { orderId: payload.orderId, correlationId },
          "Order not found to cancel"
        );
      }
    } catch (err) {
      logger.error(
        { err: err.message, correlationId },
        "Error cancelling order after reservation failure"
      );
    }
  }

  /**
   * Handle PAYMENT_COMPLETED event
   * @private
   */
  async _handlePaymentCompleted(payload, correlationId) {
    console.log(
      `✓ [Order] Payment completed for order ${payload.orderId}`
    );
    logger.info(
      { orderId: payload.orderId, correlationId },
      "Payment completed successfully"
    );
    
    try {
      const orderId = payload.orderId;
      const order = await Order.findById(orderId);
      
      if (order) {
        // Use MongoDB Transaction for atomicity
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          // Update order status to PAID
          order.status = "PAID";
          await order.save({ session });

          // Publish ORDER_PAID event (optional - for notification service)
          if (this.outboxManager) {
            await this.outboxManager.createEvent({
              eventType: "ORDER_PAID",
              payload: {
                orderId,
                transactionId: payload.transactionId,
                timestamp: new Date().toISOString()
              },
              session,
              correlationId: correlationId || orderId
            });
            logger.info({ orderId, correlationId }, "ORDER_PAID event saved to outbox");
          }

          await session.commitTransaction();
          logger.info({ orderId, correlationId }, "Order marked as PAID");
          
        } catch (txError) {
          await session.abortTransaction();
          logger.error(
            { error: txError.message, orderId, correlationId },
            "Transaction failed, rolled back"
          );
        } finally {
          session.endSession();
        }
      } else {
        logger.warn(
          { orderId: payload.orderId, correlationId },
          "Order not found to mark as paid"
        );
      }
    } catch (err) {
      logger.error(
        { err: err.message, correlationId },
        "Error updating order payment status"
      );
    }
  }

  /**
   * Handle PAYMENT_FAILED event
   * @private
   */
  async _handlePaymentFailed(payload, correlationId) {
    console.log(
      `✗ [Order] Payment failed for order ${payload.orderId}`
    );
    logger.warn(
      { orderId: payload.orderId, reason: payload.reason, correlationId },
      "Payment failed"
    );
    
    try {
      const orderId = payload.orderId;
      const order = await Order.findById(orderId);
      
      if (order) {
        // Use MongoDB Transaction for atomicity (Saga Compensation)
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          // Cancel order
          order.status = "CANCELLED";
          await order.save({ session });

          // Release ALL reserved inventory (compensation)
          if (this.outboxManager) {
            for (const product of order.products) {
              await this.outboxManager.createEvent({
                eventType: "RELEASE",
                payload: {
                  orderId,
                  productId: product._id.toString(),
                  quantity: product.quantity || 1,
                  reason: "PAYMENT_FAILED"
                },
                session,
                correlationId: correlationId || orderId
              });
            }
            logger.info(
              { orderId, productsCount: order.products.length, correlationId },
              "RELEASE compensation events saved to outbox"
            );

            // Publish ORDER_CANCELLED event
            await this.outboxManager.createEvent({
              eventType: "ORDER_CANCELLED",
              payload: {
                orderId,
                reason: `Payment failed: ${payload.reason}`,
                timestamp: new Date().toISOString()
              },
              session,
              correlationId: correlationId || orderId
            });
            logger.info(
              { orderId, reason: payload.reason, correlationId },
              "ORDER_CANCELLED event saved to outbox"
            );
          }

          await session.commitTransaction();
          logger.info({ orderId, correlationId }, "Order cancelled due to payment failure");
          
        } catch (txError) {
          await session.abortTransaction();
          logger.error(
            { error: txError.message, orderId, correlationId },
            "Transaction failed, rolled back"
          );
        } finally {
          session.endSession();
        }
      } else {
        logger.warn(
          { orderId: payload.orderId, correlationId },
          "Order not found to cancel"
        );
      }
    } catch (err) {
      logger.error(
        { err: err.message, correlationId },
        "Error cancelling order after payment failure"
      );
    }
  }

  async setupOrderConsumer(retries = 5, delay = 5000) {
    // Consumer now only listens for events from other services
    // (e.g., INVENTORY_RESERVED, PAYMENT_COMPLETED)
    // Order creation is now handled via REST API
    
    for (let i = 1; i <= retries; i++) {
      try {
        console.log(
          `⏳ [Order] Setting up event consumer... (Attempt ${i}/${retries})`
        );

        // Import MessageBroker from package (ES module)
        const { Broker } = await import("@ecommerce/message-broker");
        const broker = new Broker();

        console.log("✓ [Order] Event consumer initialized");

        // Register consumer using MessageBroker package
        await broker.consume("orders", async (data, metadata) => {
          console.log("⚡ [Order] Received event...");
          
          const { type, data: payload = {} } = data;
          const { eventId, correlationId } = metadata;

          logger.info({ 
            type, 
            eventId, 
            correlationId, 
            orderId: payload.orderId 
          }, "Processing order event");

          // Handle events from other services
          await this._handleOrderEvent(type, payload, correlationId);
        });

        console.log("✓ [Order] Event consumer registered successfully");
        return; // Success, exit the retry loop
        
      } catch (err) {
        console.error(
          `✗ [Order] Failed to setup event consumer: ${err.message}`
        );
        logger.error(
          { error: err.message, attempt: i },
          "Failed to setup event consumer"
        );
        if (i < retries) {
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise((res) => setTimeout(res, delay));
        } else {
          console.error(
            "✗ [Order] Could not setup event consumer after all retries."
          );
        }
      }
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
    await mongoose.disconnect();
    this.server.close();
    console.log("Server stopped");
  }
}

module.exports = App;
