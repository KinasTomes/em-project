const sharedConfig = require('@ecommerce/config');

const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
    serviceName: 'order-service',
    mongoURI: sharedConfig.getMongoURI('order'),
    rabbitMQUrl: process.env.RABBITMQ_URL || sharedConfig.getRabbitMQUrl(),
    rabbitMQQueue: 'orders',
    port: parseNumber(process.env.ORDER_PORT, sharedConfig.getPort(3002)),
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
};

// Set environment variables for consistency
if (!process.env.RABBITMQ_URL) {
    process.env.RABBITMQ_URL = config.rabbitMQUrl;
}

if (!process.env.REDIS_URL) {
    process.env.REDIS_URL = config.redisUrl;
}

if (!process.env.PORT) {
    process.env.PORT = String(config.port);
}

module.exports = config;
  