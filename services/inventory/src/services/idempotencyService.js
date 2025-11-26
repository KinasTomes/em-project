const redis = require('redis')
const { createClient } = redis
const logger = require('@ecommerce/logger')

/**
 * Idempotency Service for Inventory Service
 * 
 * Prevents duplicate event processing using Redis
 * Key format: inventory:event:processed:{eventType}:{identifier}
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
			logger.info({ redisUrl: this.redisUrl }, '[Inventory] Connecting to Redis for idempotency...')
			
			this.client = createClient({ url: this.redisUrl })
			
			this.client.on('error', (err) => {
				logger.error({ error: err.message }, '[Inventory] Redis connection error')
				this.isConnected = false
			})

			this.client.on('reconnecting', () => {
				logger.info('[Inventory] Reconnecting to Redis...')
			})

			await this.client.connect()
			this.isConnected = true
			logger.info('[Inventory] ✓ Redis connected for idempotency')
		} catch (error) {
			logger.error({ error: error.message }, '[Inventory] Failed to connect to Redis')
			throw error
		}
	}

	/**
	 * Generate idempotency key for event
	 * @param {string} eventType - Type of event (e.g., ORDER_CREATED)
	 * @param {string} identifier - Unique identifier (e.g., orderId, productId)
	 * @returns {string} Redis key
	 */
	_generateKey(eventType, identifier) {
		return `inventory:event:processed:${eventType}:${identifier}`
	}

	/**
	 * Check if event has already been processed
	 * @param {string} eventType - Type of event
	 * @param {string} identifier - Unique identifier (orderId or productId)
	 * @returns {Promise<boolean>} True if already processed, false otherwise
	 */
	async isProcessed(eventType, identifier) {
		if (!this.isConnected || !this.client) {
			await this.connect()
		}

		try {
			const key = this._generateKey(eventType, identifier)
			const result = await this.client.get(key)
			return result !== null
		} catch (error) {
			logger.error(
				{ error: error.message, eventType, identifier },
				'[Inventory] Error checking idempotency'
			)
			// On error, assume not processed to avoid blocking legitimate events
			return false
		}
	}

	/**
	 * Mark event as processed
	 * @param {string} eventType - Type of event
	 * @param {string} identifier - Unique identifier (orderId or productId)
	 * @param {number} ttlSeconds - Time to live in seconds (default: 24 hours)
	 */
	async markAsProcessed(eventType, identifier, ttlSeconds = 86400) {
		if (!this.isConnected || !this.client) {
			await this.connect()
		}

		try {
			const key = this._generateKey(eventType, identifier)
			await this.client.set(key, JSON.stringify({
				processedAt: new Date().toISOString(),
				eventType,
				identifier,
			}), {
				EX: ttlSeconds, // 24 hours TTL
			})
			logger.debug({ eventType, identifier }, '[Inventory] Marked event as processed')
		} catch (error) {
			logger.error(
				{ error: error.message, eventType, identifier },
				'[Inventory] Error marking event as processed'
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
			logger.info('[Inventory] Redis connection closed')
		}
	}
}

module.exports = IdempotencyService
