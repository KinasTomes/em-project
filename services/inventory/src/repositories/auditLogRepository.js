const InventoryAuditLog = require('../models/inventoryAuditLog')
const logger = require('@ecommerce/logger')

/**
 * Repository for Inventory Audit Log operations
 */
class AuditLogRepository {
	/**
	 * Create an audit log entry
	 * @param {Object} params
	 * @param {string} params.productId
	 * @param {string} params.action - RESERVE, RELEASE, RESTOCK, ADJUST, CREATE, DELETE
	 * @param {Object} params.previousValue - { available, reserved }
	 * @param {Object} params.newValue - { available, reserved }
	 * @param {string} params.reason
	 * @param {string} [params.orderId]
	 * @param {string} [params.userId]
	 * @param {string} [params.correlationId]
	 * @param {Object} [params.metadata]
	 * @param {Object} [session] - MongoDB session for transactions
	 */
	async create(params, session = null) {
		try {
			const {
				productId,
				action,
				previousValue,
				newValue,
				reason,
				orderId,
				userId,
				correlationId,
				metadata,
			} = params

			const delta = {
				available: newValue.available - previousValue.available,
				reserved: newValue.reserved - previousValue.reserved,
			}

			const auditLog = new InventoryAuditLog({
				productId,
				action,
				previousValue,
				newValue,
				delta,
				reason,
				orderId,
				userId: userId || 'system',
				correlationId,
				metadata,
			})

			const options = session ? { session } : {}
			const saved = await auditLog.save(options)

			logger.debug(
				{
					productId,
					action,
					delta,
					reason,
					orderId,
				},
				'[AuditLog] Created audit log entry'
			)

			return saved
		} catch (error) {
			logger.error(
				{ error: error.message, productId: params.productId },
				'[AuditLog] Error creating audit log'
			)
			// Don't throw - audit logging should not break main flow
			return null
		}
	}

	/**
	 * Get audit history for a product
	 */
	async getProductHistory(productId, limit = 100) {
		try {
			return await InventoryAuditLog.getProductHistory(productId, limit)
		} catch (error) {
			logger.error(
				{ error: error.message, productId },
				'[AuditLog] Error getting product history'
			)
			throw error
		}
	}

	/**
	 * Get audit history for an order
	 */
	async getOrderHistory(orderId) {
		try {
			return await InventoryAuditLog.getOrderHistory(orderId)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[AuditLog] Error getting order history'
			)
			throw error
		}
	}

	/**
	 * Get recent changes across all products
	 */
	async getRecentChanges(minutes = 60, limit = 100) {
		try {
			return await InventoryAuditLog.getRecentChanges(minutes, limit)
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[AuditLog] Error getting recent changes'
			)
			throw error
		}
	}

	/**
	 * Get changes by correlation ID (for tracing)
	 */
	async getByCorrelationId(correlationId) {
		try {
			return await InventoryAuditLog.find({ correlationId }).sort({ createdAt: 1 })
		} catch (error) {
			logger.error(
				{ error: error.message, correlationId },
				'[AuditLog] Error getting by correlation ID'
			)
			throw error
		}
	}
}

module.exports = new AuditLogRepository()
