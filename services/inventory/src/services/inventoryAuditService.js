const auditLogRepository = require('../repositories/auditLogRepository')
const logger = require('@ecommerce/logger')

/**
 * Inventory Audit Service
 * 
 * Centralized service for audit logging.
 * Single Responsibility: Only handles audit log creation and queries.
 * 
 * Benefits:
 * - Easy to change logging destination (MongoDB → ELK, etc.)
 * - Testable in isolation
 * - Removes audit logic from business service
 */
class InventoryAuditService {
	/**
	 * Log a RESERVE action
	 */
	async logReserve({ productId, previousValue, newValue, orderId, correlationId }, session = null) {
		return this._createLog({
			productId,
			action: 'RESERVE',
			previousValue,
			newValue,
			reason: 'ORDER_RESERVE',
			orderId,
			correlationId,
		}, session)
	}

	/**
	 * Log a RELEASE action
	 */
	async logRelease({ productId, previousValue, newValue, orderId, correlationId, reason = 'ORDER_CANCEL' }, session = null) {
		return this._createLog({
			productId,
			action: 'RELEASE',
			previousValue,
			newValue,
			reason,
			orderId,
			correlationId,
		}, session)
	}

	/**
	 * Log a RESTOCK action
	 */
	async logRestock({ productId, previousValue, newValue, userId, correlationId }, session = null) {
		return this._createLog({
			productId,
			action: 'RESTOCK',
			previousValue,
			newValue,
			reason: 'MANUAL_RESTOCK',
			userId,
			correlationId,
		}, session)
	}

	/**
	 * Log an ADJUST action
	 */
	async logAdjust({ productId, previousValue, newValue, userId, correlationId, metadata }, session = null) {
		return this._createLog({
			productId,
			action: 'ADJUST',
			previousValue,
			newValue,
			reason: 'MANUAL_ADJUST',
			userId,
			correlationId,
			metadata,
		}, session)
	}

	/**
	 * Log a DELETE action
	 */
	async logDelete({ productId, previousValue }, session = null) {
		return this._createLog({
			productId,
			action: 'DELETE',
			previousValue,
			newValue: { available: 0, reserved: 0 },
			reason: 'PRODUCT_DELETED',
		}, session)
	}

	/**
	 * Log a CREATE action
	 */
	async logCreate({ productId, newValue, correlationId }, session = null) {
		return this._createLog({
			productId,
			action: 'CREATE',
			previousValue: { available: 0, reserved: 0 },
			newValue,
			reason: 'PRODUCT_CREATED',
			correlationId,
		}, session)
	}

	/**
	 * Internal method to create audit log
	 * @private
	 */
	async _createLog(params, session = null) {
		try {
			return await auditLogRepository.create(params, session)
		} catch (error) {
			// Audit logging should not break main flow
			logger.error(
				{ error: error.message, productId: params.productId, action: params.action },
				'[AuditService] Failed to create audit log'
			)
			return null
		}
	}

	/**
	 * Get audit history for a product
	 */
	async getProductHistory(productId, limit = 100) {
		return auditLogRepository.getProductHistory(productId, limit)
	}

	/**
	 * Get audit history for an order
	 */
	async getOrderHistory(orderId) {
		return auditLogRepository.getOrderHistory(orderId)
	}

	/**
	 * Get recent changes
	 */
	async getRecentChanges(minutes = 60, limit = 100) {
		return auditLogRepository.getRecentChanges(minutes, limit)
	}

	/**
	 * Get changes by correlation ID
	 */
	async getByCorrelationId(correlationId) {
		return auditLogRepository.getByCorrelationId(correlationId)
	}
}

module.exports = new InventoryAuditService()
