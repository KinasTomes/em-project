const logger = require('@ecommerce/logger')
const { OrderConfirmedEventSchema } = require('../schemas/orderConfirmed.schema')
const IdempotencyService = require('../services/idempotencyService')
const PaymentService = require('../services/paymentService')

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
				logger.warn(
					{ orderId, eventId, correlationId },
					'⚠️ [Payment] Payment already processed for this order, skipping (idempotency)'
				)
				return // Skip duplicate processing
			}

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

			const result = await paymentProcessor.process({
				orderId,
				amount: payload.totalPrice,
				currency: payload.currency || 'USD',
			})

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 5: Update Payment Record & Publish Event (Transactional via Outbox)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			if (result.status === 'SUCCEEDED') {
				await paymentService.markAsSucceeded(
					orderId,
					{
						transactionId: result.transactionId,
						gatewayResponse: result,
					},
					correlationId
				)
			} else {
				await paymentService.markAsFailed(
					orderId,
					result,
					payload.products || [],
					correlationId
				)
			}

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 6: Mark as Processed (Redis Idempotency)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			await idempotencyService.markAsProcessed(orderId)
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

