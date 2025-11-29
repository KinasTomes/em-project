const { createClient } = require('redis')
const logger = require('@ecommerce/logger')

/**
 * Distributed Lock Service using Redis
 * 
 * Provides distributed locking to prevent race conditions when
 * multiple instances of Inventory Service are running.
 * 
 * Uses Redis SET with NX (only set if not exists) and PX (expiry in ms)
 * for atomic lock acquisition.
 */
class DistributedLockService {
	constructor(redisUrl) {
		this.redisUrl = redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379'
		this.client = null
		this.isConnected = false
		this.lockPrefix = 'lock:inventory:'
		this.defaultTTL = 10000 // 10 seconds default lock TTL
	}

	/**
	 * Initialize Redis connection
	 */
	async connect() {
		if (this.isConnected && this.client?.isOpen) {
			return
		}

		try {
			logger.info({ redisUrl: this.redisUrl }, '[DistributedLock] Connecting to Redis...')

			this.client = createClient({ url: this.redisUrl })

			this.client.on('error', (err) => {
				logger.error({ error: err.message }, '[DistributedLock] Redis connection error')
				this.isConnected = false
			})

			this.client.on('reconnecting', () => {
				logger.info('[DistributedLock] Reconnecting to Redis...')
			})

			await this.client.connect()
			this.isConnected = true
			logger.info('[DistributedLock] ✓ Redis connected')
		} catch (error) {
			logger.error({ error: error.message }, '[DistributedLock] Failed to connect to Redis')
			throw error
		}
	}

	/**
	 * Generate lock key for a resource
	 * @param {string} resourceType - Type of resource (e.g., 'product', 'order')
	 * @param {string} resourceId - ID of the resource
	 * @returns {string} Lock key
	 */
	_getLockKey(resourceType, resourceId) {
		return `${this.lockPrefix}${resourceType}:${resourceId}`
	}

	/**
	 * Generate unique lock value (for safe release)
	 * @returns {string} Unique lock value
	 */
	_generateLockValue() {
		return `${process.pid}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
	}

	/**
	 * Acquire a distributed lock
	 * @param {string} resourceType - Type of resource
	 * @param {string} resourceId - ID of the resource
	 * @param {number} ttlMs - Lock TTL in milliseconds (default: 10000)
	 * @param {number} retries - Number of retry attempts (default: 3)
	 * @param {number} retryDelayMs - Delay between retries in ms (default: 100)
	 * @returns {Promise<{acquired: boolean, lockValue: string|null}>}
	 */
	async acquire(resourceType, resourceId, ttlMs = this.defaultTTL, retries = 3, retryDelayMs = 100) {
		if (!this.isConnected || !this.client?.isOpen) {
			await this.connect()
		}

		const lockKey = this._getLockKey(resourceType, resourceId)
		const lockValue = this._generateLockValue()

		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				// SET key value NX PX ttl - atomic operation
				const result = await this.client.set(lockKey, lockValue, {
					NX: true, // Only set if not exists
					PX: ttlMs, // Expiry in milliseconds
				})

				if (result === 'OK') {
					logger.debug(
						{ lockKey, lockValue, ttlMs },
						'[DistributedLock] Lock acquired'
					)
					return { acquired: true, lockValue }
				}

				// Lock not acquired, retry after delay
				if (attempt < retries) {
					await this._sleep(retryDelayMs * attempt) // Exponential backoff
				}
			} catch (error) {
				logger.error(
					{ error: error.message, lockKey, attempt },
					'[DistributedLock] Error acquiring lock'
				)
				if (attempt === retries) {
					throw error
				}
			}
		}

		logger.warn(
			{ lockKey, retries },
			'[DistributedLock] Failed to acquire lock after retries'
		)
		return { acquired: false, lockValue: null }
	}

	/**
	 * Release a distributed lock
	 * Only releases if the lock value matches (prevents releasing someone else's lock)
	 * @param {string} resourceType - Type of resource
	 * @param {string} resourceId - ID of the resource
	 * @param {string} lockValue - The lock value returned from acquire()
	 * @returns {Promise<boolean>} True if released, false otherwise
	 */
	async release(resourceType, resourceId, lockValue) {
		if (!this.isConnected || !this.client?.isOpen) {
			logger.warn('[DistributedLock] Cannot release lock - not connected')
			return false
		}

		const lockKey = this._getLockKey(resourceType, resourceId)

		try {
			// Lua script for atomic check-and-delete
			// Only delete if the value matches (prevents releasing someone else's lock)
			const luaScript = `
				if redis.call("get", KEYS[1]) == ARGV[1] then
					return redis.call("del", KEYS[1])
				else
					return 0
				end
			`

			const result = await this.client.eval(luaScript, {
				keys: [lockKey],
				arguments: [lockValue],
			})

			if (result === 1) {
				logger.debug({ lockKey }, '[DistributedLock] Lock released')
				return true
			} else {
				logger.warn(
					{ lockKey, lockValue },
					'[DistributedLock] Lock not released (value mismatch or expired)'
				)
				return false
			}
		} catch (error) {
			logger.error(
				{ error: error.message, lockKey },
				'[DistributedLock] Error releasing lock'
			)
			return false
		}
	}

	/**
	 * Execute a function with a distributed lock
	 * Automatically acquires and releases the lock
	 * @param {string} resourceType - Type of resource
	 * @param {string} resourceId - ID of the resource
	 * @param {Function} fn - Async function to execute while holding the lock
	 * @param {number} ttlMs - Lock TTL in milliseconds
	 * @returns {Promise<any>} Result of the function
	 */
	async withLock(resourceType, resourceId, fn, ttlMs = this.defaultTTL) {
		const { acquired, lockValue } = await this.acquire(resourceType, resourceId, ttlMs)

		if (!acquired) {
			throw new Error(`Failed to acquire lock for ${resourceType}:${resourceId}`)
		}

		try {
			return await fn()
		} finally {
			await this.release(resourceType, resourceId, lockValue)
		}
	}

	/**
	 * Sleep helper
	 * @param {number} ms - Milliseconds to sleep
	 */
	async _sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	/**
	 * Close Redis connection
	 */
	async close() {
		if (this.client?.isOpen) {
			await this.client.quit()
			this.isConnected = false
			logger.info('[DistributedLock] Redis connection closed')
		}
	}
}

module.exports = DistributedLockService
