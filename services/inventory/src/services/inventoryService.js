const inventoryRepository = require('../repositories/inventoryRepository')
const auditService = require('./inventoryAuditService')
const { withProductLock } = require('../utils/lockExecutor')
const logger = require('@ecommerce/logger')
const mongoose = require('mongoose')

/**
 * Service layer for inventory business logic
 * 
 * Responsibilities:
 * - Business logic for inventory operations
 * - Orchestrates repository calls
 * - Delegates audit logging to AuditService
 * - Delegates locking to LockExecutor
 */
class InventoryService {
	/**
	 * Get inventory by product ID
	 */
	async getInventoryByProductId(productId) {
		const inventory = await inventoryRepository.findByProductId(productId)
		if (!inventory) {
			throw new Error('Inventory not found for this product')
		}
		return inventory
	}

	/**
	 * Create or initialize inventory for a product
	 */
	async createInventory(productId, available = 0) {
		const availableNormalized = this._normalizeQuantity(available)

		// Check if inventory already exists
		const existing = await inventoryRepository.findByProductId(productId)
		if (existing) {
			logger.info(`[InventoryService] Inventory already exists for ${productId}`)
			if (availableNormalized > 0) {
				return this.restockInventory(productId, availableNormalized)
			}
			return existing
		}

		const inventory = await inventoryRepository.create({
			productId,
			available: availableNormalized,
			reserved: 0,
			backorder: 0,
		})

		logger.info(
			`[InventoryService] Created inventory for product ${productId} with available ${availableNormalized}`
		)
		return inventory
	}

	/**
	 * Reserve inventory for an order (single product)
	 * @param {string} productId
	 * @param {number} quantity
	 * @param {Object} options - { orderId, correlationId }
	 */
	async reserveStock(productId, quantity, options = {}) {
		const { orderId, correlationId } = options

		return withProductLock(productId, async () => {
			const current = await inventoryRepository.findByProductId(productId)
			if (!current) {
				return { success: false, message: `Inventory not found for product ${productId}`, inventory: null }
			}

			const previousValue = { available: current.available, reserved: current.reserved }

			const updated = await inventoryRepository.reserveIfAvailable(productId, quantity)
			if (!updated) {
				return {
					success: false,
					message: `Insufficient stock. Available: ${current.available}, Requested: ${quantity}`,
					inventory: current,
				}
			}

			await auditService.logReserve({
				productId,
				previousValue,
				newValue: { available: updated.available, reserved: updated.reserved },
				orderId,
				correlationId,
			})

			logger.info(`[InventoryService] Reserved ${quantity} units for product ${productId}`)
			return { success: true, message: `Successfully reserved ${quantity} units`, inventory: updated }
		})
	}

	/**
	 * Reserve inventory for multiple products in a single batch operation
	 * @param {Array<{productId: string, quantity: number}>} products
	 * @param {Object} externalSession - Optional MongoDB session for transactional outbox
	 * @param {Object} options - { orderId, correlationId }
	 */
	async reserveStockBatch(products, externalSession = null, options = {}) {
		const { orderId, correlationId } = options

		const executeReserveBatch = async (session) => {
			const result = await inventoryRepository.reserveStockBatch(products, session)

			if (!result.success) {
				return { success: false, message: result.message }
			}

			// Create audit logs for each product
			if (result.previousValues) {
				for (const { productId, quantity } of products) {
					const prev = result.previousValues[productId]
					if (prev) {
						await auditService.logReserve({
							productId,
							previousValue: prev,
							newValue: { available: prev.available - quantity, reserved: prev.reserved + quantity },
							orderId,
							correlationId,
						}, session)
					}
				}
			}

			logger.info(`[InventoryService] Successfully reserved stock for ${products.length} products`)
			return { success: true, message: `All ${products.length} products reserved successfully`, modifiedCount: result.modifiedCount }
		}

		// If external session provided, use it (for transactional outbox)
		if (externalSession) {
			try {
				return await executeReserveBatch(externalSession)
			} catch (error) {
				// Check if this is a Write Conflict (retryable error)
				// Re-throw to allow caller's retry logic to handle it
				const isWriteConflict = error.message && (
					error.message.includes('Write conflict') ||
					error.message.includes('WriteConflict') ||
					error.code === 112 // MongoDB WriteConflict error code
				)
				
				if (isWriteConflict) {
					logger.warn(`[InventoryService] Write conflict detected, re-throwing for retry: ${error.message}`)
					throw error // Let caller handle retry
				}
				
				logger.warn(`[InventoryService] Batch reservation failed: ${error.message}`)
				return { success: false, message: error.message }
			}
		}

		// Otherwise, create own session
		const session = await mongoose.startSession()
		session.startTransaction()

		try {
			const result = await executeReserveBatch(session)
			if (!result.success) {
				await session.abortTransaction()
				return result
			}
			await session.commitTransaction()
			return result
		} catch (error) {
			await session.abortTransaction()
			logger.warn(`[InventoryService] Batch reservation failed: ${error.message}`)
			return { success: false, message: error.message }
		} finally {
			session.endSession()
		}
	}

	/**
	 * Release reserved inventory (e.g., when order is cancelled)
	 * @param {string} productId
	 * @param {number} quantity
	 * @param {Object} options - { orderId, correlationId, reason }
	 */
	async releaseReserved(productId, quantity, options = {}) {
		const { orderId, correlationId, reason = 'ORDER_CANCEL' } = options

		return withProductLock(productId, async () => {
			const inventory = await inventoryRepository.findByProductId(productId)
			if (!inventory) {
				throw new Error('Inventory not found for this product')
			}

			if (inventory.reserved < quantity) {
				throw new Error(`Cannot release ${quantity} units. Only ${inventory.reserved} units are reserved`)
			}

			const previousValue = { available: inventory.available, reserved: inventory.reserved }

			const updated = await inventoryRepository.updateByProductId(productId, {
				$inc: { available: quantity, reserved: -quantity },
			})

			await auditService.logRelease({
				productId,
				previousValue,
				newValue: { available: updated.available, reserved: updated.reserved },
				orderId,
				correlationId,
				reason,
			})

			logger.info(`[InventoryService] Released ${quantity} reserved units for product ${productId}`)
			return updated
		})
	}

	/**
	 * Confirm order fulfillment (decrease reserved stock)
	 */
	async confirmFulfillment(productId, quantity) {
		const inventory = await inventoryRepository.findByProductId(productId)
		if (!inventory) {
			throw new Error('Inventory not found for this product')
		}

		if (inventory.reserved < quantity) {
			throw new Error(`Cannot confirm ${quantity} units. Only ${inventory.reserved} units are reserved`)
		}

		const updated = await inventoryRepository.updateByProductId(productId, {
			$inc: { reserved: -quantity },
		})

		logger.info(`[InventoryService] Confirmed fulfillment of ${quantity} units for product ${productId}`)
		return updated
	}

	/**
	 * Restock inventory (add stock)
	 * @param {string} productId
	 * @param {number} quantity
	 * @param {Object} options - { userId, correlationId }
	 */
	async restockInventory(productId, quantity, options = {}) {
		const { userId, correlationId } = options

		if (quantity <= 0) {
			throw new Error('Restock quantity must be greater than 0')
		}

		const inventory = await inventoryRepository.findByProductId(productId)
		if (!inventory) {
			throw new Error('Inventory not found for this product')
		}

		const previousValue = { available: inventory.available, reserved: inventory.reserved }

		const updated = await inventoryRepository.updateByProductId(productId, {
			$inc: { available: quantity },
			lastRestockedAt: new Date(),
		})

		await auditService.logRestock({
			productId,
			previousValue,
			newValue: { available: updated.available, reserved: updated.reserved },
			userId,
			correlationId,
		})

		logger.info(`[InventoryService] Restocked ${quantity} units for product ${productId}`)
		return updated
	}

	/**
	 * Adjust inventory (manual adjustment by admin)
	 * @param {string} productId
	 * @param {number} availableDelta
	 * @param {number} reservedDelta
	 * @param {Object} options - { userId, correlationId, metadata }
	 */
	async adjustInventory(productId, availableDelta, reservedDelta = 0, options = {}) {
		const { userId, correlationId, metadata } = options

		const inventory = await inventoryRepository.findByProductId(productId)
		if (!inventory) {
			throw new Error('Inventory not found for this product')
		}

		const newAvailable = inventory.available + availableDelta
		const newReserved = inventory.reserved + reservedDelta

		if (newAvailable < 0 || newReserved < 0) {
			throw new Error('Adjustment would result in negative stock')
		}

		const previousValue = { available: inventory.available, reserved: inventory.reserved }

		const updated = await inventoryRepository.updateByProductId(productId, {
			$inc: { available: availableDelta, reserved: reservedDelta },
		})

		await auditService.logAdjust({
			productId,
			previousValue,
			newValue: { available: updated.available, reserved: updated.reserved },
			userId,
			correlationId,
			metadata,
		})

		logger.info(`[InventoryService] Adjusted inventory for product ${productId}`)
		return updated
	}

	/**
	 * Get all inventory with pagination
	 */
	async getAllInventory(page = 1, limit = 50) {
		return inventoryRepository.findAll(page, limit)
	}

	/**
	 * Get low stock alerts
	 */
	async getLowStockAlerts(threshold = 10) {
		return inventoryRepository.findLowStock(threshold)
	}

	/**
	 * Get out of stock products
	 */
	async getOutOfStock() {
		return inventoryRepository.findOutOfStock()
	}

	/**
	 * Check stock availability for multiple products
	 */
	async checkAvailability(productIds) {
		const checks = await Promise.all(
			productIds.map(async (productId) => {
				const inventory = await inventoryRepository.findByProductId(productId)
				return {
					productId,
					available: inventory ? inventory.available : 0,
					inStock: inventory ? inventory.isInStock() : false,
				}
			})
		)
		return checks
	}

	/**
	 * Delete inventory for a product
	 */
	async deleteInventory(productId) {
		const inventory = await inventoryRepository.deleteByProductId(productId)
		if (!inventory) {
			throw new Error('Inventory not found for this product')
		}

		await auditService.logDelete({
			productId,
			previousValue: { available: inventory.available, reserved: inventory.reserved },
		})

		logger.info(`[InventoryService] Deleted inventory for product ${productId}`)
		return inventory
	}

	/**
	 * Get audit history for a product
	 */
	async getAuditHistory(productId, limit = 100) {
		return auditService.getProductHistory(productId, limit)
	}

	/**
	 * Get audit history for an order
	 */
	async getOrderAuditHistory(orderId) {
		return auditService.getOrderHistory(orderId)
	}

	/**
	 * Normalize quantity to valid integer
	 * @private
	 */
	_normalizeQuantity(value) {
		const parsed = Number(value)
		return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
	}
}

module.exports = new InventoryService()
