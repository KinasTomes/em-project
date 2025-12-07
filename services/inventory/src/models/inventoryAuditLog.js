const mongoose = require('mongoose')

/**
 * Inventory Audit Log Model
 * 
 * Tracks all changes to inventory for compliance, debugging, and forensics.
 * Every inventory change (reserve, release, restock, adjust) creates an audit entry.
 */
const inventoryAuditLogSchema = new mongoose.Schema(
	{
		productId: {
			type: mongoose.Schema.Types.ObjectId,
			required: true,
			index: true,
		},
		action: {
			type: String,
			required: true,
			enum: ['RESERVE', 'RELEASE', 'RESTOCK', 'ADJUST', 'CREATE', 'DELETE'],
			index: true,
		},
		previousValue: {
			available: { type: Number, required: true },
			reserved: { type: Number, required: true },
		},
		newValue: {
			available: { type: Number, required: true },
			reserved: { type: Number, required: true },
		},
		delta: {
			available: { type: Number, required: true },
			reserved: { type: Number, required: true },
		},
		reason: {
			type: String,
			required: true,
			enum: [
				'ORDER_RESERVE',
				'ORDER_CANCEL',
				'PAYMENT_FAILED',
				'FULFILLMENT',
				'MANUAL_RESTOCK',
				'MANUAL_ADJUST',
				'PRODUCT_CREATED',
				'PRODUCT_DELETED',
			],
		},
		orderId: {
			type: String,
			index: true,
			description: 'Reference to order if applicable',
		},
		userId: {
			type: String,
			index: true,
			description: 'User who performed the action (system or admin)',
		},
		correlationId: {
			type: String,
			description: 'Trace ID for distributed tracing',
		},
		metadata: {
			type: mongoose.Schema.Types.Mixed,
			description: 'Additional context data',
		},
	},
	{
		timestamps: true,
		collection: 'inventory_audit_logs',
	}
)

// Compound indexes for common queries
inventoryAuditLogSchema.index({ productId: 1, createdAt: -1 })
inventoryAuditLogSchema.index({ orderId: 1, createdAt: -1 })
inventoryAuditLogSchema.index({ action: 1, createdAt: -1 })
inventoryAuditLogSchema.index({ correlationId: 1 })

/**
 * Static method: Get audit history for a product
 */
inventoryAuditLogSchema.statics.getProductHistory = function (productId, limit = 100) {
	return this.find({ productId })
		.sort({ createdAt: -1 })
		.limit(limit)
}

/**
 * Static method: Get audit history for an order
 */
inventoryAuditLogSchema.statics.getOrderHistory = function (orderId) {
	return this.find({ orderId }).sort({ createdAt: 1 })
}

/**
 * Static method: Get recent changes
 */
inventoryAuditLogSchema.statics.getRecentChanges = function (minutes = 60, limit = 100) {
	const since = new Date(Date.now() - minutes * 60 * 1000)
	return this.find({ createdAt: { $gte: since } })
		.sort({ createdAt: -1 })
		.limit(limit)
}

const InventoryAuditLog = mongoose.model('InventoryAuditLog', inventoryAuditLogSchema)

module.exports = InventoryAuditLog
