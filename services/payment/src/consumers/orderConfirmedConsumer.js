const logger = require('@ecommerce/logger')
const { OrderConfirmedEventSchema } = require('../schemas/orderConfirmed.schema')
const IdempotencyService = require('../services/idempotencyService')
const PaymentService = require('../services/paymentService')
const {
	recordPaymentProcessed,
	recordPaymentAmount,
	startPaymentProcessingTimer,
	recordPaymentRetry,
	recordGatewayError,
	recordEventProcessing,
	startEventProcessingTimer,
	recordIdempotencyCheck,
	recordOutboxEvent,
} = require('../metrics')

/**
 * Register consumer for ORDER_CONFIRMED events
 * 
 * This consumer:
 * 1. Checks idempotency (prevents duplicate processing)
 * 2. Creates/updates payment record in database
 * 3. Processes payment
 * 4. Updates payment record with result
 * 5. Publishes PAYMENT_SUCCEEDED or PAYMENT_FAILED
 */
async function registerOrderConfirmedConsumer({
	broker,
	paymentProcessor,
	config,
	idempotencyService,
	paymentService,
}) {
	const queueName = 'q.payment-service' // Payment Service's dedicated queue
	const routingKeys = ['order.confirmed'] // Only listen to order.confirmed events

	await broker.consume(
		queueName,
		async (rawPayload, metadata = {}) => {
			const { eventId, correlationId } = metadata
			
			// Validate schema - no need to filter, queue only receives ORDER_CONFIRMED
			let payload
			try {
				payload = OrderConfirmedEventSchema.parse(rawPayload)
			} catch (validationError) {
				logger.error(
					{ error: validationError.message, eventId, rawPayload },
					'❌ [Payment] ORDER_CONFIRMED schema validation failed'
				)
				throw validationError // Will be sent to DLQ by broker
			}
			
			const orderId = payload.orderId

			// Record event received and start timer
			recordEventProcessing('ORDER_CONFIRMED', 'received')
			const endEventTimer = startEventProcessingTimer('ORDER_CONFIRMED')

			logger.info(
				{
					orderId,
					queue: queueName,
					correlationId,
					eventId,
					totalPrice: payload.totalPrice,
				},
				'⏳ [Payment] Received ORDER_CONFIRMED event'
			)

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 1: Idempotency Check (Redis - fast check)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const alreadyProcessed = await idempotencyService.isProcessed(orderId)
			if (alreadyProcessed) {
				recordIdempotencyCheck(true) // Hit - duplicate
				recordEventProcessing('ORDER_CONFIRMED', 'skipped')
				logger.warn(
					{ orderId, eventId, correlationId },
					'⚠️ [Payment] Payment already processed for this order, skipping (idempotency)'
				)
				return // Skip duplicate processing
			}
			recordIdempotencyCheck(false) // Miss - new request

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 2: Create/Get Payment Record (Database - persistent)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			let payment = await paymentService.createOrGetPayment({
				orderId,
				amount: payload.totalPrice,
				currency: payload.currency || 'USD',
				correlationId,
			})

			// If payment already succeeded, skip processing
			if (payment.status === 'SUCCEEDED') {
				logger.info(
					{ orderId, transactionId: payment.transactionId },
					'[Payment] Payment already succeeded, skipping'
				)
				return
			}

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 3: Mark as Processing
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			payment = await paymentService.markAsProcessing(orderId)

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 4: Process Payment
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			logger.info(
				{
					orderId,
					amount: payload.totalPrice,
					currency: payload.currency,
					correlationId,
				},
				'💳 [Payment] Processing payment...'
			)

			// Start timer for payment processing duration
			const endProcessingTimer = startPaymentProcessingTimer('mock_gateway')

			const result = await paymentProcessor.process({
				orderId,
				amount: payload.totalPrice,
				currency: payload.currency || 'USD',
			})

			// Record retry metrics if attempts > 1
			if (result.attempts > 1) {
				for (let i = 2; i <= result.attempts; i++) {
					recordPaymentRetry(i)
				}
			}

			// Record gateway error if failed
			if (result.status === 'FAILED' && result.errorCode) {
				recordGatewayError(result.errorCode)
			}

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 5: Update Payment Record & Publish Event (Transactional via Outbox)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const currency = payload.currency || 'USD'
			if (result.status === 'SUCCEEDED') {
				await paymentService.markAsSucceeded(
					orderId,
					{
						transactionId: result.transactionId,
						gatewayResponse: result,
					},
					correlationId
				)
				// Record successful payment metrics
				recordPaymentProcessed('SUCCEEDED', 'mock_gateway')
				recordPaymentAmount(payload.totalPrice, currency, 'SUCCEEDED')
				recordOutboxEvent('PAYMENT_SUCCEEDED', 'queued')
			} else {
				await paymentService.markAsFailed(
					orderId,
					result,
					payload.products || [],
					correlationId
				)
				// Record failed payment metrics
				recordPaymentProcessed('FAILED', 'mock_gateway')
				recordPaymentAmount(payload.totalPrice, currency, 'FAILED')
				recordOutboxEvent('PAYMENT_FAILED', 'queued')
			}

			// End processing timer with status
			endProcessingTimer({ status: result.status })

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 6: Mark as Processed (Redis Idempotency)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			await idempotencyService.markAsProcessed(orderId)

			// Record event processed and end timer
			recordEventProcessing('ORDER_CONFIRMED', 'processed')
			endEventTimer()
		},
		null, // No schema at broker level - we validate in handler
		routingKeys // Bind queue to exchange with routing keys
	)

	logger.info(
		{ queue: queueName, routingKeys },
		'✓ [Payment] ORDER_CONFIRMED consumer ready (with idempotency)'
	)
}

module.exports = {
	registerOrderConfirmedConsumer,
}

