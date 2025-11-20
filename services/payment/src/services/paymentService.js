const Payment = require('../models/payment')
const logger = require('@ecommerce/logger')

/**
 * Payment Service
 * 
 * Business logic layer for payment operations.
 * Handles payment creation, updates, and queries.
 */
class PaymentService {
	constructor() {
		this.maxRetries = 3
	}

	/**
	 * Create or get existing payment record
	 * Implements idempotency: one payment per order
	 * 
	 * @param {object} params
	 * @param {string} params.orderId
	 * @param {number} params.amount
	 * @param {string} params.currency
	 * @param {string} params.correlationId
	 * @returns {Promise<Payment>}
	 */
	async createOrGetPayment({ orderId, amount, currency, correlationId }) {
		// Check if payment already exists (idempotency)
		let payment = await Payment.findByOrderId(orderId)

		if (payment) {
			logger.info(
				{ orderId, status: payment.status },
				'[PaymentService] Payment already exists, returning existing record'
			)
			return payment
		}

		// Create new payment record
		payment = new Payment({
			orderId,
			amount,
			currency: currency || 'USD',
			status: 'PENDING',
			correlationId,
		})

		await payment.save()

		logger.info(
			{ orderId, paymentId: payment._id },
			'[PaymentService] Created new payment record'
		)

		return payment
	}

	/**
	 * Update payment status to PROCESSING
	 * 
	 * @param {string} orderId
	 * @returns {Promise<Payment>}
	 */
	async markAsProcessing(orderId) {
		const payment = await Payment.findByOrderId(orderId)
		if (!payment) {
			throw new Error(`Payment not found for orderId: ${orderId}`)
		}

		payment.status = 'PROCESSING'
		payment.attempts += 1
		await payment.save()

		logger.info(
			{ orderId, attempts: payment.attempts },
			'[PaymentService] Marked payment as PROCESSING'
		)

		return payment
	}

	/**
	 * Update payment status to SUCCEEDED
	 * 
	 * @param {string} orderId
	 * @param {object} result
	 * @param {string} result.transactionId
	 * @param {object} result.gatewayResponse
	 * @returns {Promise<Payment>}
	 */
	async markAsSucceeded(orderId, result) {
		const payment = await Payment.findByOrderId(orderId)
		if (!payment) {
			throw new Error(`Payment not found for orderId: ${orderId}`)
		}

		payment.status = 'SUCCEEDED'
		payment.transactionId = result.transactionId
		payment.gatewayResponse = result.gatewayResponse || {}
		payment.processedAt = new Date()
		await payment.save()

		logger.info(
			{
				orderId,
				transactionId: payment.transactionId,
				amount: payment.amount,
			},
			'[PaymentService] Payment succeeded'
		)

		return payment
	}

	/**
	 * Update payment status to FAILED
	 * 
	 * @param {string} orderId
	 * @param {object} result
	 * @param {string} result.reason
	 * @param {Error} error
	 * @returns {Promise<Payment>}
	 */
	async markAsFailed(orderId, result, error = null) {
		const payment = await Payment.findByOrderId(orderId)
		if (!payment) {
			throw new Error(`Payment not found for orderId: ${orderId}`)
		}

		payment.status = 'FAILED'
		payment.reason = result.reason || error?.message || 'Payment failed'
		payment.transactionId = result.transactionId
		payment.processedAt = new Date()

		if (error) {
			payment.addError(error)
		}

		await payment.save()

		logger.warn(
			{
				orderId,
				reason: payment.reason,
				attempts: payment.attempts,
			},
			'[PaymentService] Payment failed'
		)

		return payment
	}

	/**
	 * Get payment by orderId
	 * 
	 * @param {string} orderId
	 * @returns {Promise<Payment|null>}
	 */
	async getPaymentByOrderId(orderId) {
		return await Payment.findByOrderId(orderId)
	}

	/**
	 * Get payment statistics
	 * 
	 * @param {Date} startDate
	 * @param {Date} endDate
	 * @returns {Promise<object>}
	 */
	async getStatistics(startDate, endDate) {
		return await Payment.getStatistics(startDate, endDate)
	}

	/**
	 * Find succeeded payments for reconciliation
	 * 
	 * @param {Date} startDate
	 * @param {Date} endDate
	 * @returns {Promise<Payment[]>}
	 */
	async findSucceededPayments(startDate, endDate) {
		return await Payment.findSucceededInRange(startDate, endDate)
	}
}

module.exports = PaymentService

