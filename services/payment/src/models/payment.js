const mongoose = require('mongoose')

/**
 * Payment Model
 * 
 * Tracks payment processing attempts and results for orders.
 * Provides audit trail, idempotency, and reconciliation capabilities.
 */
const paymentSchema = new mongoose.Schema(
	{
		orderId: {
			type: String,
			required: true,
			unique: true,
			index: true,
			description: 'Order ID - one payment per order (idempotency)',
		},
		status: {
			type: String,
			enum: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'],
			default: 'PENDING',
			index: true,
			description: 'Payment processing status',
		},
		amount: {
			type: Number,
			required: true,
			min: 0,
			description: 'Payment amount',
		},
		currency: {
			type: String,
			default: 'USD',
			description: 'Payment currency',
		},
		transactionId: {
			type: String,
			description: 'Gateway transaction ID (for reconciliation)',
		},
		gatewayResponse: {
			type: mongoose.Schema.Types.Mixed,
			description: 'Full gateway response (for debugging and audit)',
		},
		reason: {
			type: String,
			description: 'Failure reason if status is FAILED',
		},
		attempts: {
			type: Number,
			default: 0,
			description: 'Number of payment processing attempts',
		},
		errorHistory: [
			{
				attempt: { type: Number, required: true },
				error: { type: String, required: true },
				timestamp: { type: Date, default: Date.now },
			},
		],
		processedAt: {
			type: Date,
			description: 'Timestamp when payment was processed',
		},
		correlationId: {
			type: String,
			index: true,
			description: 'Correlation ID for distributed tracing',
		},
	},
	{
		timestamps: true, // createdAt, updatedAt
		collection: 'payments',
	}
)

// Indexes for performance
paymentSchema.index({ orderId: 1, status: 1 })
paymentSchema.index({ transactionId: 1 })
paymentSchema.index({ correlationId: 1, createdAt: -1 })
paymentSchema.index({ status: 1, createdAt: -1 }) // For analytics queries
paymentSchema.index({ processedAt: -1 }) // For time-based queries

/**
 * Instance method: Check if payment is in final state
 */
paymentSchema.methods.isFinalState = function () {
	return ['SUCCEEDED', 'FAILED'].includes(this.status)
}

/**
 * Instance method: Check if payment can be retried
 */
paymentSchema.methods.canRetry = function (maxAttempts = 3) {
	return (
		this.status === 'FAILED' &&
		this.attempts < maxAttempts &&
		!this.isFinalState()
	)
}

/**
 * Instance method: Add error to history
 */
paymentSchema.methods.addError = function (error) {
	if (!this.errorHistory) {
		this.errorHistory = []
	}
	this.errorHistory.push({
		attempt: this.attempts + 1,
		error: error.message || String(error),
		timestamp: new Date(),
	})
}

/**
 * Static method: Find payment by orderId (for idempotency check)
 */
paymentSchema.statics.findByOrderId = function (orderId) {
	return this.findOne({ orderId })
}

/**
 * Static method: Find succeeded payments in date range (for reconciliation)
 */
paymentSchema.statics.findSucceededInRange = function (startDate, endDate) {
	return this.find({
		status: 'SUCCEEDED',
		processedAt: {
			$gte: startDate,
			$lte: endDate,
		},
	})
}

/**
 * Static method: Get payment statistics
 */
paymentSchema.statics.getStatistics = async function (startDate, endDate) {
	const matchStage = {
		createdAt: {
			$gte: startDate || new Date(0),
			$lte: endDate || new Date(),
		},
	}

	const stats = await this.aggregate([
		{ $match: matchStage },
		{
			$group: {
				_id: '$status',
				count: { $sum: 1 },
				totalAmount: { $sum: '$amount' },
			},
		},
	])

	return stats.reduce(
		(acc, stat) => {
			acc[stat._id] = {
				count: stat.count,
				totalAmount: stat.totalAmount,
			}
			return acc
		},
		{}
	)
}

const Payment = mongoose.model('Payment', paymentSchema)

module.exports = Payment

