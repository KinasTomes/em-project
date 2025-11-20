const { v4: uuidv4 } = require('uuid')
const logger = require('@ecommerce/logger')
const { OrderConfirmedEventSchema } = require('../schemas/orderConfirmed.schema')
const IdempotencyService = require('../services/idempotencyService')
const PaymentService = require('../services/paymentService')

async function publishSuccess({ broker, config, payload, result, correlationId }) {
	const message = {
		type: 'PAYMENT_SUCCEEDED',
		data: {
			orderId: payload.orderId,
			transactionId: result.transactionId,
			amount: result.amount,
			currency: result.currency,
			processedAt: result.processedAt,
		},
	}

	await broker.publish(config.queues.orderEvents, message, {
		eventId: uuidv4(),
		correlationId,
	})

	logger.info(
		{
			orderId: payload.orderId,
			queue: config.queues.orderEvents,
			transactionId: result.transactionId,
			correlationId,
		},
		'✓ [Payment] Published PAYMENT_SUCCEEDED'
	)
}

async function publishFailure({ broker, config, payload, result, correlationId }) {
	const failurePayload = {
		type: 'PAYMENT_FAILED',
		data: {
			orderId: payload.orderId,
			transactionId: result.transactionId,
			amount: result.amount,
			currency: result.currency,
			reason: result.reason || 'Payment failed',
			processedAt: result.processedAt,
		},
	}

	const orderPublish = broker.publish(config.queues.orderEvents, failurePayload, {
		eventId: uuidv4(),
		correlationId,
	})

	const inventoryPublish = broker.publish(
		config.queues.inventoryEvents,
		{
			...failurePayload,
			data: {
				...failurePayload.data,
				compensation: true,
				products: payload.products || [],
			},
		},
		{
			eventId: uuidv4(),
			correlationId,
		}
	)

	await Promise.all([orderPublish, inventoryPublish])

	logger.warn(
		{
			orderId: payload.orderId,
			transactionId: result.transactionId,
			correlationId,
		},
		'⚠️ [Payment] Published PAYMENT_FAILED (order + inventory)'
	)
}

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
	const queueName = config.queues.orderEvents // Consume from order.events queue

	await broker.consume(
		queueName,
		async (payload, metadata = {}) => {
			const { eventId, correlationId } = metadata
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
			// STEP 5: Update Payment Record
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			if (result.status === 'SUCCEEDED') {
				await paymentService.markAsSucceeded(orderId, {
					transactionId: result.transactionId,
					gatewayResponse: result,
				})
			} else {
				await paymentService.markAsFailed(orderId, result)
			}

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 6: Mark as Processed (Redis Idempotency)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			await idempotencyService.markAsProcessed(orderId)

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 4: Publish Result
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			if (result.status === 'SUCCEEDED') {
				await publishSuccess({
					broker,
					config,
					payload,
					result,
					correlationId,
				})
			} else {
				await publishFailure({
					broker,
					config,
					payload,
					result,
					correlationId,
				})
			}
		},
		OrderConfirmedEventSchema
	)

	logger.info(
		{ queue: queueName },
		'✓ [Payment] ORDER_CONFIRMED consumer ready (with idempotency)'
	)
}

module.exports = {
	registerOrderConfirmedConsumer,
}

