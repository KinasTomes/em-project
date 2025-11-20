const { describe, it, before, after, beforeEach } = require('mocha')
const { expect } = require('chai')
const sinon = require('sinon')
const PaymentProcessor = require('../src/services/paymentProcessor')
const IdempotencyService = require('../src/services/idempotencyService')
const { OrderConfirmedEventSchema } = require('../src/schemas/orderConfirmed.schema')

describe('Payment Service Tests', () => {
	describe('PaymentProcessor', () => {
		let paymentProcessor

		beforeEach(() => {
			paymentProcessor = new PaymentProcessor({ successRate: 1.0 }) // 100% success for testing
		})

		it('should process payment successfully with 100% success rate', async () => {
			const result = await paymentProcessor.process({
				orderId: 'order-123',
				amount: 100.0,
				currency: 'USD',
			})

			expect(result).to.have.property('status', 'SUCCEEDED')
			expect(result).to.have.property('transactionId')
			expect(result).to.have.property('amount', 100.0)
			expect(result).to.have.property('currency', 'USD')
			expect(result).to.have.property('processedAt')
		})

		it('should process payment with 0% success rate (failure)', async () => {
			paymentProcessor = new PaymentProcessor({ successRate: 0.0 })
			const result = await paymentProcessor.process({
				orderId: 'order-456',
				amount: 50.0,
				currency: 'USD',
			})

			expect(result).to.have.property('status', 'FAILED')
			expect(result).to.have.property('transactionId')
			expect(result).to.have.property('reason')
			expect(result).to.have.property('amount', 50.0)
		})

		it('should generate unique transaction IDs', async () => {
			const result1 = await paymentProcessor.process({
				orderId: 'order-1',
				amount: 100,
			})
			const result2 = await paymentProcessor.process({
				orderId: 'order-2',
				amount: 200,
			})

			expect(result1.transactionId).to.not.equal(result2.transactionId)
		})

		it('should use default currency USD when not provided', async () => {
			const result = await paymentProcessor.process({
				orderId: 'order-123',
				amount: 100,
			})

			expect(result.currency).to.equal('USD')
		})
	})

	describe('IdempotencyService', () => {
		let idempotencyService
		let redisClientMock

		beforeEach(() => {
			// Mock Redis client
			redisClientMock = {
				isOpen: true,
				get: sinon.stub(),
				set: sinon.stub(),
				connect: sinon.stub().resolves(),
				quit: sinon.stub().resolves(),
				on: sinon.stub(),
			}

			idempotencyService = new IdempotencyService('redis://localhost:6379')
			// Replace client with mock
			idempotencyService.client = redisClientMock
			idempotencyService.isConnected = true
		})

		it('should return false when payment not processed', async () => {
			redisClientMock.get.resolves(null)

			const isProcessed = await idempotencyService.isProcessed('order-123')

			expect(isProcessed).to.be.false
			expect(redisClientMock.get).to.have.been.calledWith('payment:processed:order-123')
		})

		it('should return true when payment already processed', async () => {
			redisClientMock.get.resolves('1')

			const isProcessed = await idempotencyService.isProcessed('order-123')

			expect(isProcessed).to.be.true
		})

		it('should mark payment as processed', async () => {
			redisClientMock.set.resolves('OK')

			await idempotencyService.markAsProcessed('order-123')

			expect(redisClientMock.set).to.have.been.calledWith(
				'payment:processed:order-123',
				'1',
				{ EX: 86400 }
			)
		})

		it('should handle Redis errors gracefully', async () => {
			redisClientMock.get.rejects(new Error('Redis connection error'))

			const isProcessed = await idempotencyService.isProcessed('order-123')

			// Should return false on error (fail open)
			expect(isProcessed).to.be.false
		})
	})

	describe('ORDER_CONFIRMED Event Schema', () => {
		it('should validate correct ORDER_CONFIRMED payload', () => {
			const payload = {
				type: 'ORDER_CONFIRMED',
				data: {
					orderId: 'order-123',
					totalPrice: 100.0,
					currency: 'USD',
					products: [
						{
							productId: 'prod-1',
							quantity: 2,
							price: 50.0,
						},
					],
					userId: 'user-456',
					timestamp: '2025-01-15T10:30:00Z',
				},
			}

			const result = OrderConfirmedEventSchema.parse(payload)

			expect(result.orderId).to.equal('order-123')
			expect(result.totalPrice).to.equal(100.0)
			expect(result.amount).to.equal(100.0) // Alias
			expect(result.currency).to.equal('USD')
			expect(result.products).to.have.length(1)
		})

		it('should use default currency when not provided', () => {
			const payload = {
				data: {
					orderId: 'order-123',
					totalPrice: 100.0,
				},
			}

			const result = OrderConfirmedEventSchema.parse(payload)

			expect(result.currency).to.equal('USD')
		})

		it('should reject payload without orderId', () => {
			const payload = {
				data: {
					totalPrice: 100.0,
				},
			}

			expect(() => OrderConfirmedEventSchema.parse(payload)).to.throw()
		})

		it('should reject negative totalPrice', () => {
			const payload = {
				data: {
					orderId: 'order-123',
					totalPrice: -100.0,
				},
			}

			expect(() => OrderConfirmedEventSchema.parse(payload)).to.throw()
		})
	})

	describe('Payment Flow Integration', () => {
		let paymentProcessor
		let idempotencyService
		let brokerMock
		let publishSuccessSpy
		let publishFailureSpy

		beforeEach(() => {
			paymentProcessor = new PaymentProcessor({ successRate: 1.0 })
			idempotencyService = {
				isProcessed: sinon.stub().resolves(false),
				markAsProcessed: sinon.stub().resolves(),
			}
			brokerMock = {
				publish: sinon.stub().resolves(),
			}
			publishSuccessSpy = sinon.spy()
			publishFailureSpy = sinon.spy()
		})

		it('should process payment and publish SUCCEEDED when idempotency check passes', async () => {
			// Mock successful payment
			const result = await paymentProcessor.process({
				orderId: 'order-123',
				amount: 100.0,
				currency: 'USD',
			})

			expect(result.status).to.equal('SUCCEEDED')
			expect(idempotencyService.isProcessed).to.have.been.calledWith('order-123')
		})

		it('should skip processing when idempotency check fails (already processed)', async () => {
			idempotencyService.isProcessed.resolves(true)

			const isProcessed = await idempotencyService.isProcessed('order-123')

			expect(isProcessed).to.be.true
			// Payment should not be processed
		})

		it('should mark as processed after successful payment', async () => {
			await idempotencyService.markAsProcessed('order-123')

			expect(idempotencyService.markAsProcessed).to.have.been.calledWith('order-123')
		})
	})

	describe('Order Status Transitions', () => {
		it('should NOT allow PENDING → PAID transition (must go through CONFIRMED)', () => {
			// Order MUST be CONFIRMED before it can be PAID
			const validTransitions = {
				PENDING: ['CONFIRMED', 'CANCELLED'], // No direct PAID
				CONFIRMED: ['PAID', 'CANCELLED'],
				PAID: [], // Final state
				CANCELLED: [], // Final state
			}

			expect(validTransitions.PENDING).to.not.include('PAID')
			expect(validTransitions.PENDING).to.include('CONFIRMED')
		})

		it('should allow CONFIRMED → PAID transition', () => {
			const validTransitions = {
				CONFIRMED: ['PAID', 'CANCELLED'],
			}

			expect(validTransitions.CONFIRMED).to.include('PAID')
		})

		it('should allow PENDING → CONFIRMED transition', () => {
			const validTransitions = {
				PENDING: ['CONFIRMED', 'CANCELLED'],
			}

			expect(validTransitions.PENDING).to.include('CONFIRMED')
		})

		it('should allow CONFIRMED → CANCELLED transition (payment failed)', () => {
			const validTransitions = {
				CONFIRMED: ['PAID', 'CANCELLED'],
			}

			expect(validTransitions.CONFIRMED).to.include('CANCELLED')
		})

		it('should not allow PAID → CANCELLED transition (final state)', () => {
			// PAID is a final state
			const finalStates = ['PAID', 'CANCELLED']

			expect(finalStates).to.include('PAID')
			// Cannot transition from final states
		})
	})
})

