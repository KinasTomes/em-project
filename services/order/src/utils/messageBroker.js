const amqp = require("amqplib");
const config = require("../config");
const OrderService = require("../services/orderService");

class MessageBroker {
  static async connect(retries = 5, delay = 5000) {
    for (let i = 1; i <= retries; i++) {
      try {
        console.log(`⏳ [Order] Connecting to RabbitMQ... (Attempt ${i}/${retries})`);
        const connection = await amqp.connect(config.rabbitMQURI);
        const channel = await connection.createChannel();

        // Declare the order queue
        await channel.assertQueue(config.rabbitMQQueue, { durable: true });
        console.log("✓ [Order] RabbitMQ connected and queue asserted");

        // Consume messages from the order queue on buy
        channel.consume(config.rabbitMQQueue, async (message) => {
          if (message === null) {
            return;
          }
          try {
            const order = JSON.parse(message.content.toString());
            const orderService = new OrderService();
            await orderService.createOrder(order);
            channel.ack(message);
            console.log(`[Order] Processed order ${order.id}`);
          } catch (error) {
            console.error("✗ [Order] Error processing message:", error);
            channel.reject(message, false); // Reject without requeueing
          }
        });
        return; // Success
      } catch (error) {
        console.error(`✗ [Order] Failed to connect to RabbitMQ: ${error.message}`);
        if (i < retries) {
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise(res => setTimeout(res, delay));
        } else {
          console.error("✗ [Order] Could not connect to RabbitMQ after all retries.");
        }
      }
    }
  }
}

module.exports = MessageBroker;
