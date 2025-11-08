const amqp = require("amqplib");
const config = require("../config");

class MessageBroker {
  constructor() {
    this.channel = null;
  }

  async connect() {
    await this.connectWithRetry();
  }

  async connectWithRetry(retries = 5, delay = 5000) {
    for (let i = 1; i <= retries; i++) {
      try {
        console.log(`⏳ [Product] Connecting to RabbitMQ... (Attempt ${i}/${retries})`);
        const connection = await amqp.connect(config.rabbitMQURI);
        this.channel = await connection.createChannel();
        await this.channel.assertQueue("products");
        console.log("✓ [Product] RabbitMQ connected");
        return; // Success, exit the loop
      } catch (err) {
        console.error(`✗ [Product] Failed to connect to RabbitMQ: ${err.message}`);
        if (i < retries) {
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise(res => setTimeout(res, delay));
        } else {
          console.error("✗ [Product] Could not connect to RabbitMQ after all retries. Exiting.");
          // process.exit(1); // Optional: exit if connection is critical
        }
      }
    }
  }

  async publishMessage(queue, message) {
    if (!this.channel) {
      console.error("No RabbitMQ channel available.");
      return;
    }

    try {
      await this.channel.sendToQueue(
        queue,
        Buffer.from(JSON.stringify(message))
      );
    } catch (err) {
      console.log(err);
    }
  }

  async consumeMessage(queue, callback) {
    if (!this.channel) {
      console.error("No RabbitMQ channel available.");
      return;
    }

    try {
      await this.channel.consume(queue, (message) => {
        const content = message.content.toString();
        const parsedContent = JSON.parse(content);
        callback(parsedContent);
        this.channel.ack(message);
      });
    } catch (err) {
      console.log(err);
    }
  }
}

module.exports = new MessageBroker();
