const Payment = require('../models/payment')
const logger = require('@ecommerce/logger')

/**
 * Repository layer for Payment operations
 * Handles all database interactions
 */
class PaymentRepository {
	/**
	 * Find payment by ID
	 */
	async findById(paymentId, session = null) {
		try {
			const query = Payment.findById(paymentId)
			if (session) {
				query.session(session)
			}
			return await query
		} catch (error) {
			logger.error(
				{ error: error.message, paymentId },
				'[PaymentRepository] Error finding payment'
			)
			throw error
		}
	}

	/**
	 * Find payment by order ID (idempotency check)
	 */
	async findByOrderId(orderId, session = null) {
		try {
			const query = Payment.findOne({ orderId })
			if (session) {
				query.session(session)
			}
			return await query
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error finding payment by orderId'
			)
			throw error
		}
	}

	/**
	 * Create new payment
	 */
	async create(paymentData, session = null) {
		try {
			const payment = new Payment(paymentData)
			const options = session ? { session } : {}
			return await payment.save(options)
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[PaymentRepository] Error creating payment'
			)
			throw error
		}
	}

	/**
	 * Save payment instance
	 */
	async save(payment, session = null) {
		try {
			const options = session ? { session } : {}
			return await payment.save(options)
		} catch (error) {
			logger.error(
				{ error: error.message, paymentId: payment._id },
				'[PaymentRepository] Error saving payment'
			)
			throw error
		}
	}

	/**
	 * Update payment by order ID
	 */
	async updateByOrderId(orderId, updateData, session = null) {
		try {
			const options = { new: true, runValidators: true }
			if (session) {
				options.session = session
			}
			return await Payment.findOneAndUpdate({ orderId }, updateData, options)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error updating payment'
			)
			throw error
		}
	}

	/**
	 * Update payment status
	 */
	async updateStatus(orderId, status, additionalData = {}, session = null) {
		try {
			const updateData = { status, ...additionalData }
			const options = { new: true, runValidators: true }
			if (session) {
				options.session = session
			}
			return await Payment.findOneAndUpdate({ orderId }, updateData, options)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId, status },
				'[PaymentRepository] Error updating payment status'
			)
			throw error
		}
	}

	/**
	 * Find payments by status
	 */
	async findByStatus(status, page = 1, limit = 50) {
		try {
			const skip = (page - 1) * limit
			const [items, total] = await Promise.all([
				Payment.find({ status })
					.skip(skip)
					.limit(limit)
					.sort({ createdAt: -1 }),
				Payment.countDocuments({ status }),
			])
			return {
				items,
				total,
				page,
				pages: Math.ceil(total / limit),
			}
		} catch (error) {
			logger.error(
				{ error: error.message, status },
				'[PaymentRepository] Error finding payments by status'
			)
			throw error
		}
	}

	/**
	 * Find succeeded payments in date range (for reconciliation)
	 */
	async findSucceededInRange(startDate, endDate) {
		try {
			return await Payment.find({
				status: 'SUCCEEDED',
				processedAt: {
					$gte: startDate,
					$lte: endDate,
				},
			})
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[PaymentRepository] Error finding succeeded payments'
			)
			throw error
		}
	}

	/**
	 * Get all payments with pagination
	 */
	async findAll(page = 1, limit = 50) {
		try {
			const skip = (page - 1) * limit
			const [items, total] = await Promise.all([
				Payment.find().skip(skip).limit(limit).sort({ createdAt: -1 }),
				Payment.countDocuments(),
			])
			return {
				items,
				total,
				page,
				pages: Math.ceil(total / limit),
			}
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[PaymentRepository] Error finding all payments'
			)
			throw error
		}
	}

	/**
	 * Delete payment by order ID
	 */
	async deleteByOrderId(orderId) {
		try {
			return await Payment.findOneAndDelete({ orderId })
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error deleting payment'
			)
			throw error
		}
	}

	/**
	 * Get payment statistics
	 */
	async getStatistics(startDate, endDate) {
		try {
			const matchStage = {
				createdAt: {
					$gte: startDate || new Date(0),
					$lte: endDate || new Date(),
				},
			}

			const stats = await Payment.aggregate([
				{ $match: matchStage },
				{
					$group: {
						_id: '$status',
						count: { $sum: 1 },
						totalAmount: { $sum: '$amount' },
					},
				},
			])

			return stats.reduce((acc, stat) => {
				acc[stat._id] = {
					count: stat.count,
					totalAmount: stat.totalAmount,
				}
				return acc
			}, {})
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[PaymentRepository] Error getting statistics'
			)
			throw error
		}
	}

	/**
	 * Increment payment attempts
	 */
	async incrementAttempts(orderId, session = null) {
		try {
			const options = { new: true }
			if (session) {
				options.session = session
			}
			return await Payment.findOneAndUpdate(
				{ orderId },
				{ $inc: { attempts: 1 } },
				options
			)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error incrementing attempts'
			)
			throw error
		}
	}

	/**
	 * Add error to payment history
	 */
	async addErrorToHistory(orderId, errorMessage, attempt, session = null) {
		try {
			const options = { new: true }
			if (session) {
				options.session = session
			}
			return await Payment.findOneAndUpdate(
				{ orderId },
				{
					$push: {
						errorHistory: {
							attempt,
							error: errorMessage,
							timestamp: new Date(),
						},
					},
				},
				options
			)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error adding error to history'
			)
			throw error
		}
	}

	/**
	 * Atomic update to PROCESSING status
	 * Only updates if payment is in PENDING state (race-safe)
	 */
	async atomicUpdateToProcessing(orderId, session = null) {
		try {
			const options = { new: true, runValidators: true }
			if (session) {
				options.session = session
			}
			return await Payment.findOneAndUpdate(
				{
					orderId,
					status: 'PENDING', // Only update if still PENDING
				},
				{
					status: 'PROCESSING',
					$inc: { attempts: 1 },
				},
				options
			)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error atomic update to PROCESSING'
			)
			throw error
		}
	}

	/**
	 * Atomic update to SUCCEEDED status
	 * Only updates if payment is in non-final state (race-safe)
	 */
	async atomicUpdateToSucceeded(
		orderId,
		transactionId,
		gatewayResponse,
		session = null
	) {
		try {
			const options = { new: true, runValidators: true }
			if (session) {
				options.session = session
			}
			return await Payment.findOneAndUpdate(
				{
					orderId,
					status: { $in: ['PENDING', 'PROCESSING'] }, // Only if not final
				},
				{
					status: 'SUCCEEDED',
					transactionId,
					gatewayResponse,
					processedAt: new Date(),
				},
				options
			)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error atomic update to SUCCEEDED'
			)
			throw error
		}
	}

	/**
	 * Atomic update to FAILED status
	 * Only updates if payment is in non-final state (race-safe)
	 */
	async atomicUpdateToFailed(
		orderId,
		reason,
		transactionId,
		errorMessage = null,
		attempt = 0,
		session = null
	) {
		try {
			const options = { new: true, runValidators: true }
			if (session) {
				options.session = session
			}

			const updateData = {
				status: 'FAILED',
				reason,
				transactionId,
				processedAt: new Date(),
			}

			// Add error to history if provided
			if (errorMessage) {
				updateData.$push = {
					errorHistory: {
						attempt,
						error: errorMessage,
						timestamp: new Date(),
					},
				}
			}

			return await Payment.findOneAndUpdate(
				{
					orderId,
					status: { $in: ['PENDING', 'PROCESSING'] }, // Only if not final
				},
				updateData,
				options
			)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[PaymentRepository] Error atomic update to FAILED'
			)
			throw error
		}
	}
}

module.exports = new PaymentRepository()
