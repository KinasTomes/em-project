const redis = require('redis')
const { createClient } = redis
const logger = require('@ecommerce/logger')

/**
 * Idempotency Service for Order Service
 * 
 * Prevents duplicate event processing using Redis
 * Key format: order:event:processed:{eventType}:{orderId}
 * TTL: 24 hours
 */
class IdempotencyService {
	constructor(redisUrl) {
		this.redisUrl = redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379'
		this.client = null
		this.isConnected = false
	}

	/**
	 * Initialize Redis connection
	 */
	async connect() {
		if (this.isConnected && this.client && this.client.isOpen) {
			return
		}

		try {
			logger.info({ redisUrl: this.redisUrl }, '[Order] Connecting to Redis for idempotency...')
			
			this.client = createClient({ url: this.redisUrl })
			
			this.client.on('error', (err) => {
				logger.error({ error: err.message }, '[Order] Redis connection error')
				this.isConnected = false
			})

			this.client.on('reconnecting', () => {
				logger.info('[Order] Reconnecting to Redis...')
			})

			await this.client.connect()
			this.isConnected = true
			logger.info('[Order] ✓ Redis connected for idempotency')
		} catch (error) {
			logger.error({ error: error.message }, '[Order] Failed to connect to Redis')
			throw error
		}
	}

	/**
	 * Generate idempotency key for event
	 * @param {string} eventType - Type of event (e.g., INVENTORY_RESERVED_SUCCESS)
	 * @param {string} orderId - Order ID
	 * @returns {string} Redis key
	 */
	_generateKey(eventType, orderId) {
		return `order:event:processed:${eventType}:${orderId}`
	}

	/**
	 * Check if event has already been processed for an order
	 * @param {string} eventType - Type of event
	 * @param {string} orderId - Order ID
	 * @returns {Promise<boolean>} True if already processed, false otherwise
	 */
	async isProcessed(eventType, orderId) {
		if (!this.isConnected || !this.client) {
			await this.connect()
		}

		try {
			const key = this._generateKey(eventType, orderId)
			const result = await this.client.get(key)
			return result !== null
		} catch (error) {
			logger.error(
				{ error: error.message, eventType, orderId },
				'[Order] Error checking idempotency'
			)
			// On error, assume not processed to avoid blocking legitimate events
			return false
		}
	}

	/**
	 * Mark event as processed for an order
	 * @param {string} eventType - Type of event
	 * @param {string} orderId - Order ID
	 * @param {number} ttlSeconds - Time to live in seconds (default: 24 hours)
	 */
	async markAsProcessed(eventType, orderId, ttlSeconds = 86400) {
		if (!this.isConnected || !this.client) {
			await this.connect()
		}

		try {
			const key = this._generateKey(eventType, orderId)
			await this.client.set(key, JSON.stringify({
				processedAt: new Date().toISOString(),
				eventType,
				orderId,
			}), {
				EX: ttlSeconds, // 24 hours TTL
			})
			logger.debug({ eventType, orderId }, '[Order] Marked event as processed')
		} catch (error) {
			logger.error(
				{ error: error.message, eventType, orderId },
				'[Order] Error marking event as processed'
			)
			// Don't throw - idempotency is best effort
		}
	}

	/**
	 * Close Redis connection
	 */
	async close() {
		if (this.client && this.client.isOpen) {
			await this.client.quit()
			this.isConnected = false
			logger.info('[Order] Redis connection closed')
		}
	}
}

module.exports = IdempotencyService
