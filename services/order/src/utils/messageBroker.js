const amqp = require("amqplib");
const config = require("../config");
const logger = require("@ecommerce/logger");

class MessageBroker {
  constructor() {
    this.connection = null;
    this.channel = null;
  }

  async connect(retries = 5, delay = 5000) {
    for (let i = 1; i <= retries; i++) {
      try {
        console.log(
          `⏳ [Order] Connecting to RabbitMQ... (Attempt ${i}/${retries})`
        );
        this.connection = await amqp.connect(config.rabbitMQURI);
        this.channel = await this.connection.createChannel();

        // Declare the queues
        await this.channel.assertQueue("orders", { durable: true });
        await this.channel.assertQueue("products", { durable: true });
        await this.channel.assertQueue("inventory", { durable: true });

        console.log("✓ [Order] RabbitMQ connected and queues asserted");
        logger.info("RabbitMQ connected successfully");
        return;
      } catch (error) {
        console.error(
          `✗ [Order] Failed to connect to RabbitMQ: ${error.message}`
        );
        logger.error(
          { error: error.message, attempt: i },
          "Failed to connect to RabbitMQ"
        );
        if (i < retries) {
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise((res) => setTimeout(res, delay));
        } else {
          console.error(
            "✗ [Order] Could not connect to RabbitMQ after all retries."
          );
          throw new Error("Could not connect to RabbitMQ");
        }
      }
    }
  }

  async publishMessage(queue, message) {
    if (!this.channel) {
      throw new Error("RabbitMQ channel not initialized");
    }

    try {
      const messageBuffer = Buffer.from(JSON.stringify(message));
      this.channel.sendToQueue(queue, messageBuffer, { persistent: true });
      logger.info({ queue, messageType: message.type }, "Message published");
    } catch (error) {
      logger.error(
        { error: error.message, queue },
        "Failed to publish message"
      );
      throw error;
    }
  }

  async close() {
    if (this.channel) {
      await this.channel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }
    console.log("✓ [Order] RabbitMQ connection closed");
  }
}

module.exports = MessageBroker;
