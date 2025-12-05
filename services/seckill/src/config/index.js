const sharedConfig = require('@ecommerce/config')

const parseNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const config = {
  serviceName: 'seckill-service',
  rabbitMQUrl: process.env.RABBITMQ_URL || sharedConfig.getRabbitMQUrl(),
  rabbitMQQueue: 'seckill',
  port: parseNumber(process.env.SECKILL_PORT, parseNumber(process.env.PORT, sharedConfig.getPort(3006))),
  
  // Dedicated Redis instance for seckill (separate from main cache)
  redisUrl: process.env.REDIS_SECKILL_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6380',
  
  // Admin authentication
  adminKey: process.env.SECKILL_ADMIN_KEY || 'seckill-admin-key',
  
  // Rate limiting configuration
  rateLimit: parseNumber(process.env.SECKILL_RATE_LIMIT, 5),
  rateWindow: parseNumber(process.env.SECKILL_RATE_WINDOW, 1),
}

// Set environment variables for consistency
if (!process.env.RABBITMQ_URL) {
  process.env.RABBITMQ_URL = config.rabbitMQUrl
}

if (!process.env.REDIS_SECKILL_URL) {
  process.env.REDIS_SECKILL_URL = config.redisUrl
}

if (!process.env.PORT) {
  process.env.PORT = String(config.port)
}

module.exports = config
