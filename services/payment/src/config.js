const baseConfig = require('@ecommerce/config')

const parseNumber = (value, fallback) => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}

const clampRate = (value, fallback) => {
	const normalized = parseNumber(value, fallback)
	if (!Number.isFinite(normalized)) return fallback
	return Math.min(Math.max(normalized, 0), 1)
}

const config = {
	serviceName: 'payment-service',
	port: parseNumber(process.env.PAYMENT_PORT, 3006),
	queues: {
		stockReserved: process.env.STOCK_RESERVED_QUEUE || 'STOCK_RESERVED',
		orderEvents: process.env.ORDER_EVENTS_QUEUE || 'orders',
		inventoryEvents: process.env.INVENTORY_EVENTS_QUEUE || 'inventory',
	},
	payment: {
		successRate: clampRate(process.env.PAYMENT_SUCCESS_RATE, 0.9),
	},
	rabbitMQUrl: process.env.RABBITMQ_URL || baseConfig.getRabbitMQUrl(),
	redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
}

if (!process.env.RABBITMQ_URL) {
	process.env.RABBITMQ_URL = config.rabbitMQUrl
}

if (!process.env.REDIS_URL) {
	process.env.REDIS_URL = config.redisUrl
}

if (!process.env.PORT) {
	process.env.PORT = String(config.port)
}

module.exports = config

