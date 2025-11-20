const redis = require('redis')
const { createClient } = redis
const logger = require('@ecommerce/logger')

/**
 * Idempotency Service
 * 
 * Prevents duplicate payment processing using Redis
 * Key format: payment:processed:{orderId}
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
			logger.info({ redisUrl: this.redisUrl }, '[Payment] Connecting to Redis for idempotency...')
			
			this.client = createClient({ url: this.redisUrl })
			
			this.client.on('error', (err) => {
				logger.error({ error: err.message }, '[Payment] Redis connection error')
				this.isConnected = false
			})

			this.client.on('reconnecting', () => {
				logger.info('[Payment] Reconnecting to Redis...')
			})

			await this.client.connect()
			this.isConnected = true
			logger.info('[Payment] ✓ Redis connected for idempotency')
		} catch (error) {
			logger.error({ error: error.message }, '[Payment] Failed to connect to Redis')
			throw error
		}
	}

	/**
	 * Check if payment has already been processed for an order
	 * @param {string} orderId - Order ID
	 * @returns {Promise<boolean>} True if already processed, false otherwise
	 */
	async isProcessed(orderId) {
		if (!this.isConnected || !this.client) {
			await this.connect()
		}

		try {
			const key = `payment:processed:${orderId}`
			const result = await this.client.get(key)
			return result !== null
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[Payment] Error checking idempotency'
			)
			// On error, assume not processed to avoid blocking legitimate payments
			return false
		}
	}

	/**
	 * Mark payment as processed for an order
	 * @param {string} orderId - Order ID
	 * @param {number} ttlSeconds - Time to live in seconds (default: 24 hours)
	 */
	async markAsProcessed(orderId, ttlSeconds = 86400) {
		if (!this.isConnected || !this.client) {
			await this.connect()
		}

		try {
			const key = `payment:processed:${orderId}`
			await this.client.set(key, '1', {
				EX: ttlSeconds, // 24 hours TTL
			})
			logger.debug({ orderId }, '[Payment] Marked payment as processed')
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[Payment] Error marking payment as processed'
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
			logger.info('[Payment] Redis connection closed')
		}
	}
}

module.exports = IdempotencyService

