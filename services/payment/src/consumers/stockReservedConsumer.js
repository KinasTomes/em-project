const { v4: uuidv4 } = require('uuid')
const logger = require('@ecommerce/logger')
const { StockReservedEventSchema } = require('../schemas/stockReserved.schema')

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
				products: payload.products,
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

async function registerStockReservedConsumer({ broker, paymentProcessor, config }) {
	const queueName = config.queues.stockReserved

	await broker.consume(
		queueName,
		async (payload, metadata = {}) => {
			const correlationId = metadata.correlationId || payload.orderId

			logger.info(
				{
					orderId: payload.orderId,
					queue: queueName,
					correlationId,
					eventId: metadata.eventId,
					type: payload.rawType,
				},
				'⏳ [Payment] Processing STOCK_RESERVED event'
			)

			const result = await paymentProcessor.process({
				orderId: payload.orderId,
				amount: payload.amount,
				currency: payload.currency,
			})

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
		StockReservedEventSchema
	)

	logger.info({ queue: queueName }, '✓ [Payment] STOCK_RESERVED consumer ready')
}

module.exports = {
	registerStockReservedConsumer,
}

