const express = require("express");
const mongoose = require("mongoose");
const Order = require("./models/order");
const amqp = require("amqplib");
const config = require("./config");
const logger = require("@ecommerce/logger");

class App {
  constructor() {
    this.app = express();
    this.connectDB();
    this.setupOrderConsumer();
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
    for (let i = 1; i <= retries; i++) {
      try {
        console.log(`⏳ [Order] Connecting to RabbitMQ... (Attempt ${i}/${retries})`);
        const amqpServer = config.rabbitMQURI;
        const connection = await amqp.connect(amqpServer);
        console.log("✓ [Order] RabbitMQ connected");
        logger.info({ rabbitMQURI: config.rabbitMQURI }, "RabbitMQ connected");
        const channel = await connection.createChannel();
        await channel.assertQueue("orders");
  
        channel.consume("orders", async (data) => {
          // Consume messages from the order queue on buy
          console.log("⚡ [Order] Processing order...");
          logger.info("Processing new order");
          const { products, username, orderId } = JSON.parse(data.content);
  
          const newOrder = new Order({
            products,
            user: username,
            totalPrice: products.reduce((acc, product) => acc + product.price, 0),
          });
  
          // Save order to DB
          await newOrder.save();
  
          // Send ACK to ORDER service
          channel.ack(data);
          console.log("✓ [Order] Order saved to DB and ACK sent");
          logger.info({ orderId: newOrder._id }, "Order saved and acknowledged");
  
          // Send fulfilled order to PRODUCTS service
          // Include orderId in the message
          const { user, products: savedProducts, totalPrice } = newOrder.toJSON();
          channel.sendToQueue(
            "products",
            Buffer.from(JSON.stringify({ orderId, user, products: savedProducts, totalPrice }))
          );
        });
        return; // Success, exit the retry loop
      } catch (err) {
        console.error(`✗ [Order] Failed to connect to RabbitMQ: ${err.message}`);
        logger.error({ error: err.message, attempt: i }, "Failed to connect to RabbitMQ");
        if (i < retries) {
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise(res => setTimeout(res, delay));
        } else {
          console.error("✗ [Order] Could not connect to RabbitMQ after all retries.");
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
