const sharedConfig = require("@ecommerce/config");

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
  serviceName: 'inventory-service',
  mongoURI: sharedConfig.getMongoURI("inventory"),
  rabbitMQUrl: process.env.RABBITMQ_URL || sharedConfig.getRabbitMQUrl(),
  rabbitMQQueue: "inventory",
  port: parseNumber(process.env.INVENTORY_PORT, sharedConfig.getPort(3005)),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  // Align JWT secret with shared configuration to keep services in sync
  jwtSecret: sharedConfig.JWT_SECRET,
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
