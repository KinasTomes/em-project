const sharedConfig = require("@ecommerce/config");

module.exports = {
  port: sharedConfig.getPort(3001),
  mongoURI: sharedConfig.getMongoURI('product'),
  rabbitMQURI: sharedConfig.getRabbitMQUrl(),
  exchangeName: "products",
  queueName: "products_queue",
};
