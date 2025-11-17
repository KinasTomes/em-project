const { v4: uuidv4 } = require('uuid')

class PaymentProcessor {
	constructor({ successRate = 0.9 } = {}) {
		this.successRate = Math.min(Math.max(successRate, 0), 1)
	}

	/**
	 * Process a payment request (mocked for now)
	 * @param {object} command
	 * @param {string} command.orderId
	 * @param {number} [command.amount]
	 * @param {string} [command.currency]
	 * @returns {Promise<object>}
	 */
	async process(command) {
		const decision = Math.random()
		const transactionId = uuidv4()
		const processedAt = new Date().toISOString()

		if (decision <= this.successRate) {
			return {
				status: 'SUCCEEDED',
				transactionId,
				processedAt,
				amount: command.amount ?? null,
				currency: command.currency ?? 'USD',
			}
		}

		return {
			status: 'FAILED',
			transactionId,
			processedAt,
			amount: command.amount ?? null,
			currency: command.currency ?? 'USD',
			reason: 'Mock gateway declined the payment',
		}
	}
}

module.exports = PaymentProcessor

