const sharedConfig = require('@ecommerce/config');

module.exports = {
    mongoURI: sharedConfig.getMongoURI('order'),
    rabbitMQURI: sharedConfig.RABBITMQ_URL,
    rabbitMQQueue: 'orders',
    port: sharedConfig.getPort(3002),
};
  