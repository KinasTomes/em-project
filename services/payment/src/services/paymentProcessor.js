const { v4: uuidv4 } = require('uuid')
const logger = require('@ecommerce/logger')

/**
 * Transient errors that should trigger retry
 */
const TRANSIENT_ERRORS = [
	'GATEWAY_TIMEOUT',
	'NETWORK_ERROR',
	'SERVICE_UNAVAILABLE',
	'RATE_LIMITED',
]

class PaymentProcessor {
	constructor({ successRate = 0.9, maxRetries = 3, baseDelayMs = 1000 } = {}) {
		this.successRate = Math.min(Math.max(successRate, 0), 1)
		this.maxRetries = maxRetries
		this.baseDelayMs = baseDelayMs
	}

	/**
	 * Sleep for specified milliseconds
	 * @param {number} ms
	 */
	async _sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	/**
	 * Calculate delay with exponential backoff + jitter
	 * @param {number} attempt - Current attempt (0-indexed)
	 * @returns {number} Delay in milliseconds
	 */
	_calculateDelay(attempt) {
		// Exponential backoff: baseDelay * 2^attempt
		const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt)
		// Add jitter (±25%) to prevent thundering herd
		const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1)
		return Math.floor(exponentialDelay + jitter)
	}

	/**
	 * Check if error is transient (retryable)
	 * @param {object} result
	 * @returns {boolean}
	 */
	_isTransientError(result) {
		return result.status === 'FAILED' && TRANSIENT_ERRORS.includes(result.errorCode)
	}

	/**
	 * Simulate a single payment attempt (mocked gateway call)
	 * @param {object} command
	 * @returns {Promise<object>}
	 */
	async _attemptPayment(command) {
		const decision = Math.random()
		const transactionId = uuidv4()
		const processedAt = new Date().toISOString()

		// Simulate transient errors (10% of failures are transient)
		if (decision > this.successRate) {
			const isTransient = Math.random() < 0.3 // 30% of failures are transient
			
			if (isTransient) {
				const transientError = TRANSIENT_ERRORS[Math.floor(Math.random() * TRANSIENT_ERRORS.length)]
				return {
					status: 'FAILED',
					transactionId,
					processedAt,
					amount: command.amount ?? null,
					currency: command.currency ?? 'USD',
					reason: `Transient error: ${transientError}`,
					errorCode: transientError,
					retryable: true,
				}
			}

			return {
				status: 'FAILED',
				transactionId,
				processedAt,
				amount: command.amount ?? null,
				currency: command.currency ?? 'USD',
				reason: 'Mock gateway declined the payment',
				errorCode: 'PAYMENT_DECLINED',
				retryable: false,
			}
		}

		return {
			status: 'SUCCEEDED',
			transactionId,
			processedAt,
			amount: command.amount ?? null,
			currency: command.currency ?? 'USD',
		}
	}

	/**
	 * Process a payment request with retry and exponential backoff
	 * @param {object} command
	 * @param {string} command.orderId
	 * @param {number} [command.amount]
	 * @param {string} [command.currency]
	 * @returns {Promise<object>}
	 */
	async process(command) {
		let lastResult = null
		let attempt = 0

		while (attempt <= this.maxRetries) {
			lastResult = await this._attemptPayment(command)

			// Success - return immediately
			if (lastResult.status === 'SUCCEEDED') {
				if (attempt > 0) {
					logger.info(
						{ orderId: command.orderId, attempt: attempt + 1 },
						'💳 [PaymentProcessor] Payment succeeded after retry'
					)
				}
				return { ...lastResult, attempts: attempt + 1 }
			}

			// Non-retryable failure - return immediately
			if (!this._isTransientError(lastResult)) {
				logger.warn(
					{ orderId: command.orderId, reason: lastResult.reason, attempt: attempt + 1 },
					'💳 [PaymentProcessor] Payment failed (non-retryable)'
				)
				return { ...lastResult, attempts: attempt + 1 }
			}

			// Retryable failure - check if we have retries left
			if (attempt < this.maxRetries) {
				const delay = this._calculateDelay(attempt)
				logger.warn(
					{
						orderId: command.orderId,
						reason: lastResult.reason,
						attempt: attempt + 1,
						maxRetries: this.maxRetries,
						nextRetryMs: delay,
					},
					'💳 [PaymentProcessor] Transient error, retrying with backoff...'
				)
				await this._sleep(delay)
			}

			attempt++
		}

		// All retries exhausted
		logger.error(
			{
				orderId: command.orderId,
				reason: lastResult.reason,
				totalAttempts: attempt,
			},
			'💳 [PaymentProcessor] Payment failed after all retries'
		)

		return {
			...lastResult,
			attempts: attempt,
			reason: `${lastResult.reason} (after ${attempt} attempts)`,
		}
	}
}

module.exports = PaymentProcessor

