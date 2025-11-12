const express = require("express");
const mongoose = require("mongoose");
const Order = require("./models/order");
const amqp = require("amqplib");
const config = require("./config");
const logger = require("@ecommerce/logger");
const MessageBroker = require("./utils/messageBroker");
const OrderService = require("./services/orderService");
const OrderController = require("./controllers/orderController");
const orderRoutes = require("./routes/orderRoutes");

// Import Outbox Pattern (will use dynamic import for ES modules)
let OutboxManager;

class App {
  constructor() {
    this.app = express();
    this.messageBroker = null;
    this.outboxManager = null;
    this.connectDB();
    this.setMiddlewares();
    this.setupMessageBroker();
    this.initOutbox();
    this.setRoutes();
    this.setupOrderConsumer();
  }

  setMiddlewares() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
  }

  async setupMessageBroker() {
    this.messageBroker = new MessageBroker();
    await this.messageBroker.connect();
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

  async setupOrderConsumer(retries = 5, delay = 5000) {
    // Consumer now only listens for events from other services
    // (e.g., INVENTORY_RESERVED, PAYMENT_COMPLETED)
    // Order creation is now handled via REST API
    for (let i = 1; i <= retries; i++) {
      try {
        console.log(
          `⏳ [Order] Setting up event consumer... (Attempt ${i}/${retries})`
        );
        const amqpServer = config.rabbitMQURI;
        const connection = await amqp.connect(amqpServer);
        console.log("✓ [Order] Event consumer RabbitMQ connected");
        const channel = await connection.createChannel();
        await channel.assertQueue("orders");

        channel.consume("orders", async (data) => {
          console.log("⚡ [Order] Received event...");

          let parsed;
          try {
            parsed = JSON.parse(data.content.toString());
          } catch (parseError) {
            console.error("✗ [Order] Failed to parse event", parseError);
            logger.error(
              { error: parseError.message },
              "Failed to parse event message"
            );
            channel.reject(data, false);
            return;
          }

          const { type, data: payload = {} } = parsed;

          // Handle events from other services
          switch (type) {
            case "INVENTORY_RESERVED":
              console.log(
                `✓ [Order] Inventory reserved for order ${payload.orderId}`
              );
              logger.info(
                { orderId: payload.orderId },
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
                          correlationId: orderId
                        });
                        logger.info(
                          { orderId },
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
                    logger.info({ orderId, productId }, "Order updated successfully");
                    
                  } catch (txError) {
                    await session.abortTransaction();
                    logger.error(
                      { error: txError.message, orderId },
                      "Transaction failed, rolled back"
                    );
                  } finally {
                    session.endSession();
                  }
                } else {
                  logger.warn(
                    { orderId: payload.orderId },
                    "Order not found to update reservation"
                  );
                }
              } catch (err) {
                logger.error(
                  { err: err.message },
                  "Error updating order reservation status"
                );
              }
              break;

            case "INVENTORY_RESERVE_FAILED":
              console.log(
                `✗ [Order] Inventory reserve failed for order ${payload.orderId}`
              );
              logger.warn(
                { orderId: payload.orderId, reason: payload.reason },
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
                          correlationId: orderId
                        });
                      }
                      logger.info(
                        { orderId, releasedCount: reservedProducts.length },
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
                        correlationId: orderId
                      });
                      logger.info(
                        { orderId, reason: payload.reason },
                        "ORDER_CANCELLED event saved to outbox"
                      );
                    }

                    await session.commitTransaction();
                    logger.info({ orderId }, "Order cancelled successfully");
                    
                  } catch (txError) {
                    await session.abortTransaction();
                    logger.error(
                      { error: txError.message, orderId },
                      "Transaction failed, rolled back"
                    );
                  } finally {
                    session.endSession();
                  }
                } else {
                  logger.warn(
                    { orderId: payload.orderId },
                    "Order not found to cancel"
                  );
                }
              } catch (err) {
                logger.error(
                  { err: err.message },
                  "Error cancelling order after reservation failure"
                );
              }
              break;

            case "PAYMENT_COMPLETED":
              console.log(
                `✓ [Order] Payment completed for order ${payload.orderId}`
              );
              logger.info(
                { orderId: payload.orderId },
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
                        correlationId: orderId
                      });
                      logger.info({ orderId }, "ORDER_PAID event saved to outbox");
                    }

                    await session.commitTransaction();
                    logger.info({ orderId }, "Order marked as PAID");
                    
                  } catch (txError) {
                    await session.abortTransaction();
                    logger.error(
                      { error: txError.message, orderId },
                      "Transaction failed, rolled back"
                    );
                  } finally {
                    session.endSession();
                  }
                } else {
                  logger.warn(
                    { orderId: payload.orderId },
                    "Order not found to mark as paid"
                  );
                }
              } catch (err) {
                logger.error(
                  { err: err.message },
                  "Error updating order payment status"
                );
              }
              break;

            case "PAYMENT_FAILED":
              console.log(
                `✗ [Order] Payment failed for order ${payload.orderId}`
              );
              logger.warn(
                { orderId: payload.orderId, reason: payload.reason },
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
                          correlationId: orderId
                        });
                      }
                      logger.info(
                        { orderId, productsCount: order.products.length },
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
                        correlationId: orderId
                      });
                      logger.info(
                        { orderId, reason: payload.reason },
                        "ORDER_CANCELLED event saved to outbox"
                      );
                    }

                    await session.commitTransaction();
                    logger.info({ orderId }, "Order cancelled due to payment failure");
                    
                  } catch (txError) {
                    await session.abortTransaction();
                    logger.error(
                      { error: txError.message, orderId },
                      "Transaction failed, rolled back"
                    );
                  } finally {
                    session.endSession();
                  }
                } else {
                  logger.warn(
                    { orderId: payload.orderId },
                    "Order not found to cancel"
                  );
                }
              } catch (err) {
                logger.error(
                  { err: err.message },
                  "Error cancelling order after payment failure"
                );
              }
              break;

            default:
              console.warn(`⚠️  [Order] Unknown event type: ${type}`);
              logger.warn({ type }, "Received unknown event type");
          }

          channel.ack(data);
        });
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
