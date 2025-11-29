const logger = require('@ecommerce/logger')

// Distributed lock service (injected from app.js)
let distributedLockService = null

/**
 * Set the distributed lock service instance
 * @param {Object} lockService - DistributedLockService instance
 */
function setLockService(lockService) {
	distributedLockService = lockService
}

/**
 * Get the current lock service instance
 * @returns {Object|null}
 */
function getLockService() {
	return distributedLockService
}

/**
 * Execute a function with optional distributed lock
 * 
 * If lock service is available, acquires lock before execution.
 * If not available (e.g., single instance), executes directly.
 * 
 * @param {string} resourceType - Type of resource (e.g., 'product')
 * @param {string} resourceId - ID of the resource
 * @param {Function} fn - Async function to execute
 * @param {number} ttlMs - Lock TTL in milliseconds (default: 5000)
 * @returns {Promise<any>} Result of the function
 */
async function withLock(resourceType, resourceId, fn, ttlMs = 5000) {
	if (distributedLockService) {
		return distributedLockService.withLock(resourceType, resourceId, fn, ttlMs)
	}
	
	// No lock service - execute directly (single instance mode)
	logger.debug(
		{ resourceType, resourceId },
		'[LockExecutor] No lock service, executing without lock'
	)
	return fn()
}

/**
 * Execute a function with lock on a product
 * Convenience wrapper for product-specific locking
 * 
 * @param {string} productId - Product ID to lock
 * @param {Function} fn - Async function to execute
 * @param {number} ttlMs - Lock TTL in milliseconds (default: 5000)
 * @returns {Promise<any>} Result of the function
 */
async function withProductLock(productId, fn, ttlMs = 5000) {
	return withLock('product', productId, fn, ttlMs)
}

/**
 * Execute a function with lock on an order
 * Convenience wrapper for order-specific locking
 * 
 * @param {string} orderId - Order ID to lock
 * @param {Function} fn - Async function to execute
 * @param {number} ttlMs - Lock TTL in milliseconds (default: 5000)
 * @returns {Promise<any>} Result of the function
 */
async function withOrderLock(orderId, fn, ttlMs = 5000) {
	return withLock('order', orderId, fn, ttlMs)
}

module.exports = {
	setLockService,
	getLockService,
	withLock,
	withProductLock,
	withOrderLock,
}
