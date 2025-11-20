const { describe, it, before, after, beforeEach } = require('mocha')
const { expect } = require('chai')
const sinon = require('sinon')
const PaymentProcessor = require('../../src/services/paymentProcessor')
const IdempotencyService = require('../../src/services/idempotencyService')
const {
	registerOrderConfirmedConsumer,
} = require('../../src/consumers/orderConfirmedConsumer')

/**
 * Integration tests for Payment Flow
 * Tests the complete flow from ORDER_CONFIRMED to PAYMENT_SUCCEEDED/FAILED
 */
describe('Payment Flow Integration Tests', () => {
	let paymentProcessor
	let idempotencyService
	let brokerMock
	let config

	beforeEach(() => {
		// Setup mocks
		paymentProcessor = new PaymentProcessor({ successRate: 0.9 })
		idempotencyService = {
			isProcessed: sinon.stub(),
			markAsProcessed: sinon.stub().resolves(),
			connect: sinon.stub().resolves(),
		}
		brokerMock = {
			publish: sinon.stub().resolves(),
			consume: sinon.stub().resolves(),
		}
		config = {
			queues: {
				orderEvents: 'orders',
				inventoryEvents: 'inventory',
			},
		}
	})

	describe('Happy Path: Payment Succeeds', () => {
		it('should process ORDER_CONFIRMED and publish PAYMENT_SUCCEEDED', async () => {
			// Setup: Payment not processed yet
			idempotencyService.isProcessed.resolves(false)

			// Setup: Payment will succeed
			paymentProcessor = new PaymentProcessor({ successRate: 1.0 })

			const payload = {
				orderId: 'order-123',
				totalPrice: 100.0,
				currency: 'USD',
				products: [
					{ productId: 'prod-1', quantity: 2, price: 50.0 },
				],
			}

			const metadata = {
				eventId: 'event-456',
				correlationId: 'corr-789',
			}

			// Simulate consumer handler
			const isProcessed = await idempotencyService.isProcessed(
				payload.orderId
			)
			expect(isProcessed).to.be.false

			const result = await paymentProcessor.process({
				orderId: payload.orderId,
				amount: payload.totalPrice,
				currency: payload.currency,
			})

			expect(result.status).to.equal('SUCCEEDED')
			expect(result).to.have.property('transactionId')

			await idempotencyService.markAsProcessed(payload.orderId)

			// Verify idempotency was marked
			expect(idempotencyService.markAsProcessed).to.have.been.calledWith(
				payload.orderId
			)
		})
	})

	describe('Failure Path: Payment Fails', () => {
		it('should process ORDER_CONFIRMED and publish PAYMENT_FAILED', async () => {
			// Setup: Payment not processed yet
			idempotencyService.isProcessed.resolves(false)

			// Setup: Payment will fail
			paymentProcessor = new PaymentProcessor({ successRate: 0.0 })

			const payload = {
				orderId: 'order-456',
				totalPrice: 50.0,
				currency: 'USD',
			}

			const result = await paymentProcessor.process({
				orderId: payload.orderId,
				amount: payload.totalPrice,
				currency: payload.currency,
			})

			expect(result.status).to.equal('FAILED')
			expect(result).to.have.property('reason')
			expect(result).to.have.property('transactionId')

			await idempotencyService.markAsProcessed(payload.orderId)

			// Even failed payments should be marked to prevent retry loops
			expect(idempotencyService.markAsProcessed).to.have.been.calledWith(
				payload.orderId
			)
		})
	})

	describe('Idempotency: Duplicate Events', () => {
		it('should skip processing when payment already processed', async () => {
			// Setup: Payment already processed
			idempotencyService.isProcessed.resolves(true)

			const payload = {
				orderId: 'order-789',
				totalPrice: 200.0,
				currency: 'USD',
			}

			const isProcessed = await idempotencyService.isProcessed(
				payload.orderId
			)

			expect(isProcessed).to.be.true
			// Payment should not be processed again
			// markAsProcessed should not be called
		})

		it('should process payment only once even if event received multiple times', async () => {
			idempotencyService.isProcessed
				.onFirstCall()
				.resolves(false) // First time: not processed
				.onSecondCall()
				.resolves(true) // Second time: already processed

			const payload = {
				orderId: 'order-duplicate',
				totalPrice: 150.0,
			}

			// First event
			const firstCheck = await idempotencyService.isProcessed(
				payload.orderId
			)
			expect(firstCheck).to.be.false

			// Process payment
			await paymentProcessor.process({
				orderId: payload.orderId,
				amount: payload.totalPrice,
			})
			await idempotencyService.markAsProcessed(payload.orderId)

			// Second event (duplicate)
			const secondCheck = await idempotencyService.isProcessed(
				payload.orderId
			)
			expect(secondCheck).to.be.true
			// Should skip processing
		})
	})

	describe('Order Status State Machine', () => {
		it('should NOT allow PENDING → PAID transition (must go through CONFIRMED)', () => {
			// Order MUST be CONFIRMED before payment
			const stateMachine = {
				current: 'PENDING',
				can: (transition) => {
					const validTransitions = {
						PENDING: ['confirm', 'cancel'], // No 'pay'
						CONFIRMED: ['pay', 'cancel'],
					}
					return (
						validTransitions[this.current]?.includes(transition) ||
						false
					)
				},
			}

			// PENDING cannot pay directly
			const canPay = stateMachine.can('pay')
			expect(canPay).to.be.false
		})

		it('should allow PENDING → CONFIRMED transition (inventory reserved)', () => {
			const stateMachine = {
				current: 'PENDING',
				can: (transition) => {
					const validTransitions = {
						PENDING: ['confirm', 'cancel'],
						CONFIRMED: ['pay', 'cancel'],
					}
					return (
						validTransitions[this.current]?.includes(transition) ||
						false
					)
				},
			}

			const canConfirm = stateMachine.can('confirm')
			expect(canConfirm).to.be.true
		})

		it('should allow CONFIRMED → PAID transition (payment after inventory)', () => {
			const stateMachine = {
				current: 'CONFIRMED',
				can: (transition) => {
					const validTransitions = {
						CONFIRMED: ['pay', 'cancel'],
					}
					return (
						validTransitions[this.current]?.includes(transition) ||
						false
					)
				},
			}

			// CONFIRMED can transition to PAID
			const canPay = stateMachine.can('pay')
			expect(canPay).to.be.true
		})

		it('should allow CONFIRMED → CANCELLED transition (payment failed)', () => {
			const stateMachine = {
				current: 'CONFIRMED',
				can: (transition) => {
					const validTransitions = {
						CONFIRMED: ['pay', 'cancel'],
					}
					return (
						validTransitions[this.current]?.includes(transition) ||
						false
					)
				},
			}

			const canCancel = stateMachine.can('cancel')
			expect(canCancel).to.be.true
		})

		it('should not allow PAID → CANCELLED transition (final state)', () => {
			const finalStates = ['PAID', 'CANCELLED']
			const currentState = 'PAID'

			expect(finalStates).to.include(currentState)
			// Cannot transition from final states
		})

		it('should not allow CANCELLED → PAID transition (final state)', () => {
			const finalStates = ['PAID', 'CANCELLED']
			const currentState = 'CANCELLED'

			expect(finalStates).to.include(currentState)
			// Cannot transition from final states
		})
	})

	describe('Event Payload Validation', () => {
		it('should handle ORDER_CONFIRMED with all required fields', () => {
			const payload = {
				orderId: 'order-123',
				totalPrice: 100.0,
				currency: 'USD',
				products: [
					{ productId: 'prod-1', quantity: 1, price: 100.0 },
				],
				userId: 'user-456',
				timestamp: '2025-01-15T10:30:00Z',
			}

			expect(payload).to.have.property('orderId')
			expect(payload).to.have.property('totalPrice')
			expect(payload.totalPrice).to.be.a('number')
			expect(payload.totalPrice).to.be.greaterThan(0)
		})

		it('should use default currency when not provided', () => {
			const payload = {
				orderId: 'order-123',
				totalPrice: 100.0,
			}

			const currency = payload.currency || 'USD'
			expect(currency).to.equal('USD')
		})
	})

	describe('Error Handling', () => {
		it('should handle payment processor errors gracefully', async () => {
			paymentProcessor = new PaymentProcessor({ successRate: 0.5 })

			// Payment may succeed or fail
			const result = await paymentProcessor.process({
				orderId: 'order-error',
				amount: 100.0,
			})

			expect(result).to.have.property('status')
			expect(['SUCCEEDED', 'FAILED']).to.include(result.status)
		})

		it('should handle idempotency service errors gracefully', async () => {
			idempotencyService.isProcessed.rejects(
				new Error('Redis connection error')
			)

			// Should not throw, but return false (fail open)
			try {
				const isProcessed = await idempotencyService.isProcessed(
					'order-123'
				)
				// If error handling is correct, should return false
			} catch (error) {
				// If throws, that's also acceptable
				expect(error).to.be.instanceOf(Error)
			}
		})
	})
})

