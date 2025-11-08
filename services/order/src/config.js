const sharedConfig = require('@ecommerce/config');

module.exports = {
    mongoURI: sharedConfig.getMongoURI('order'),
    rabbitMQURI: sharedConfig.getRabbitMQUrl(),
    rabbitMQQueue: 'orders',
    port: sharedConfig.getPort(3002),
};
  