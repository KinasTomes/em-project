const paymentRepository = require('../repositories/paymentRepository')
const logger = require('@ecommerce/logger')
const mongoose = require('mongoose')

/**
 * Payment Service
 * 
 * Business logic layer for payment operations.
 * Handles payment creation, updates, and queries.
 */
class PaymentService {
	constructor(outboxManager) {
		this.outboxManager = outboxManager
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
		let payment = await paymentRepository.findByOrderId(orderId)

		if (payment) {
			logger.info(
				{ orderId, status: payment.status },
				'[PaymentService] Payment already exists, returning existing record'
			)
			return payment
		}

		// Create new payment record
		payment = await paymentRepository.create({
			orderId,
			amount,
			currency: currency || 'USD',
			status: 'PENDING',
			correlationId,
		})

		logger.info(
			{ orderId, paymentId: payment._id },
			'[PaymentService] Created new payment record'
		)

		return payment
	}

	/**
	 * Update payment status to PROCESSING
	 * Uses atomic update to prevent race conditions
	 * 
	 * @param {string} orderId
	 * @returns {Promise<Payment>}
	 */
	async markAsProcessing(orderId) {
		const payment = await paymentRepository.atomicUpdateToProcessing(orderId)
		
		if (!payment) {
			// Payment not found OR already processed by another instance
			const existing = await paymentRepository.findByOrderId(orderId)
			if (!existing) {
				throw new Error(`Payment not found for orderId: ${orderId}`)
			}
			logger.info(
				{ orderId, status: existing.status },
				'[PaymentService] Payment already being processed by another instance (race condition avoided)'
			)
			return existing
		}

		logger.info(
			{ orderId, attempts: payment.attempts },
			'[PaymentService] Marked payment as PROCESSING'
		)

		return payment
	}

	/**
	 * Update payment status to SUCCEEDED and publish event via Outbox
	 * Uses atomic update to prevent race conditions between multiple instances
	 * 
	 * Idempotent: If payment is already SUCCEEDED, skip creating duplicate event
	 * 
	 * @param {string} orderId
	 * @param {object} result
	 * @param {string} result.transactionId
	 * @param {object} result.gatewayResponse
	 * @param {string} correlationId
	 * @returns {Promise<Payment>}
	 */
	async markAsSucceeded(orderId, result, correlationId) {
		const session = await mongoose.startSession()
		session.startTransaction()

		try {
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// ATOMIC UPDATE: Only update if status is PENDING or PROCESSING
			// This prevents race conditions when multiple instances process same order
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const payment = await paymentRepository.atomicUpdateToSucceeded(
				orderId,
				result.transactionId,
				result.gatewayResponse || {},
				session
			)

			if (!payment) {
				// Payment already in final state (processed by another instance)
				await session.abortTransaction()
				const existing = await paymentRepository.findByOrderId(orderId)
				logger.info(
					{ orderId, status: existing?.status },
					'[PaymentService] Payment already in final state, skipping (race condition avoided)'
				)
				return existing
			}

			// Publish PAYMENT_SUCCEEDED via Outbox (transactional)
			// Use orderId as part of eventId to ensure idempotency at outbox level
			await this.outboxManager.createEvent({
				eventType: 'PAYMENT_SUCCEEDED',
				payload: {
					type: 'PAYMENT_SUCCEEDED',
					data: {
						orderId,
						transactionId: result.transactionId,
						amount: payment.amount,
						currency: payment.currency,
						processedAt: payment.processedAt.toISOString(),
					},
				},
				session,
				eventId: `payment-succeeded:${orderId}`, // Deterministic eventId for idempotency
				correlationId,
				routingKey: 'payment.succeeded',
			})

			await session.commitTransaction()

			logger.info(
				{
					orderId,
					transactionId: payment.transactionId,
					amount: payment.amount,
				},
				'[PaymentService] Payment succeeded and event queued via Outbox'
			)

			return payment
		} catch (error) {
			await session.abortTransaction()
			
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// Handle duplicate key error on outbox eventId
			// This means another instance already created the event - treat as success
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const isDuplicateKeyError = error.code === 11000 || 
				(error.message && error.message.includes('E11000 duplicate key error'))
			
			if (isDuplicateKeyError) {
				logger.info(
					{ orderId, error: error.message },
					'[PaymentService] Duplicate eventId detected - event already created by another instance (idempotent)'
				)
				// Return the existing payment
				const existingPayment = await paymentRepository.findByOrderId(orderId)
				return existingPayment
			}
			
			logger.error(
				{ error: error.message, orderId },
				'[PaymentService] Failed to mark payment as succeeded'
			)
			throw error
		} finally {
			session.endSession()
		}
	}

	/**
	 * Update payment status to FAILED and publish event via Outbox
	 * Uses atomic update to prevent race conditions between multiple instances
	 * 
	 * Idempotent: If payment is already in final state (SUCCEEDED/FAILED), skip
	 * 
	 * @param {string} orderId
	 * @param {object} result
	 * @param {string} result.reason
	 * @param {Array} products
	 * @param {string} correlationId
	 * @param {Error} error
	 * @returns {Promise<Payment>}
	 */
	async markAsFailed(orderId, result, products, correlationId, error = null) {
		const session = await mongoose.startSession()
		session.startTransaction()

		try {
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// ATOMIC UPDATE: Only update if status is PENDING or PROCESSING
			// This prevents race conditions when multiple instances process same order
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const payment = await paymentRepository.atomicUpdateToFailed(
				orderId,
				result.reason || error?.message || 'Payment failed',
				result.transactionId,
				error ? error.message : null,
				0, // attempt number - could be retrieved from payment if needed
				session
			)

			if (!payment) {
				// Payment already in final state (processed by another instance)
				await session.abortTransaction()
				const existing = await paymentRepository.findByOrderId(orderId)
				logger.info(
					{ orderId, status: existing?.status },
					'[PaymentService] Payment already in final state, skipping (race condition avoided)'
				)
				return existing
			}

			// Publish PAYMENT_FAILED via Outbox (transactional)
			// Use orderId as part of eventId to ensure idempotency at outbox level
			await this.outboxManager.createEvent({
				eventType: 'PAYMENT_FAILED',
				payload: {
					type: 'PAYMENT_FAILED',
					data: {
						orderId,
						transactionId: result.transactionId,
						amount: payment.amount,
						currency: payment.currency,
						reason: payment.reason,
						processedAt: payment.processedAt.toISOString(),
						products: products || [],
					},
				},
				session,
				eventId: `payment-failed:${orderId}`, // Deterministic eventId for idempotency
				correlationId,
				routingKey: 'payment.failed',
			})

			await session.commitTransaction()

			logger.warn(
				{
					orderId,
					reason: payment.reason,
					attempts: payment.attempts,
				},
				'[PaymentService] Payment failed and event queued via Outbox'
			)

			return payment
		} catch (err) {
			await session.abortTransaction()
			
			// Handle duplicate key error on outbox eventId
			const isDuplicateKeyError = err.code === 11000 || 
				(err.message && err.message.includes('E11000 duplicate key error'))
			
			if (isDuplicateKeyError) {
				logger.info(
					{ orderId, error: err.message },
					'[PaymentService] Duplicate eventId detected - event already created (idempotent)'
				)
				const existingPayment = await paymentRepository.findByOrderId(orderId)
				return existingPayment
			}
			
			logger.error(
				{ error: err.message, orderId },
				'[PaymentService] Failed to mark payment as failed'
			)
			throw err
		} finally {
			session.endSession()
		}
	}

	/**
	 * Get payment by orderId
	 * 
	 * @param {string} orderId
	 * @returns {Promise<Payment|null>}
	 */
	async getPaymentByOrderId(orderId) {
		return await paymentRepository.findByOrderId(orderId)
	}

	/**
	 * Get payment statistics
	 * 
	 * @param {Date} startDate
	 * @param {Date} endDate
	 * @returns {Promise<object>}
	 */
	async getStatistics(startDate, endDate) {
		return await paymentRepository.getStatistics(startDate, endDate)
	}

	/**
	 * Find succeeded payments for reconciliation
	 * 
	 * @param {Date} startDate
	 * @param {Date} endDate
	 * @returns {Promise<Payment[]>}
	 */
	async findSucceededPayments(startDate, endDate) {
		return await paymentRepository.findSucceededInRange(startDate, endDate)
	}
}

module.exports = PaymentService
