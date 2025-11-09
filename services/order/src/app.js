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

class App {
  constructor() {
    this.app = express();
    this.messageBroker = null;
    this.connectDB();
    this.setMiddlewares();
    this.setupMessageBroker();
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

  setRoutes() {
    // Initialize service and controller
    const orderService = new OrderService(this.messageBroker);
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
                // Mark product as reserved on the order and set status to CONFIRMED when all reserved
                const orderId = payload.orderId;
                const productId = payload.productId;
                const order = await Order.findById(orderId);
                if (order) {
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
                    // Optionally publish ORDER_CONFIRMED
                    await this.messageBroker.publishMessage("orders", {
                      type: "ORDER_CONFIRMED",
                      data: { orderId, timestamp: new Date().toISOString() },
                    });
                    logger.info(
                      { orderId },
                      "Order confirmed (all items reserved)"
                    );
                  }

                  if (changed) {
                    await order.save();
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
                  order.status = "CANCELLED";
                  await order.save();
                  // Release any previously reserved items for this order
                  for (const p of order.products.filter((pp) => pp.reserved)) {
                    await this.messageBroker.publishMessage("inventory", {
                      type: "RELEASE",
                      data: {
                        orderId,
                        productId: p._id.toString(),
                        quantity: 1,
                      },
                      timestamp: new Date().toISOString(),
                    });
                  }
                  // Optionally publish ORDER_CANCELLED
                  await this.messageBroker.publishMessage("orders", {
                    type: "ORDER_CANCELLED",
                    data: { orderId, reason: payload.reason },
                    timestamp: new Date().toISOString(),
                  });
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
              // TODO: Update order status to 'paid'
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
