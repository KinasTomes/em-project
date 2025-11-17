const { z } = require('zod')
const { v4: uuidv4 } = require('uuid')
const logger = require('@ecommerce/logger')

const StockReservedEventSchema = z.union([
	z
		.object({
			type: z.string().optional(),
			data: z
				.object({
					orderId: z.string().min(1, 'orderId is required'),
					totalPrice: z.number().nonnegative().optional(),
					totalAmount: z.number().nonnegative().optional(),
					amount: z.number().nonnegative().optional(),
					currency: z.string().min(1).optional(),
					reservedAt: z.string().optional(),
					userId: z.string().optional(),
					products: z
						.array(
							z.object({
								productId: z.string().min(1),
								quantity: z.number().int().positive().optional(),
								price: z.number().nonnegative().optional(),
							})
						)
						.optional(),
				})
				.passthrough(),
		})
		.passthrough(),
	z
		.object({
			orderId: z.string().min(1, 'orderId is required'),
			productId: z.string().optional(),
			quantity: z.number().int().positive().optional(),
			totalAmount: z.number().nonnegative().optional(),
			amount: z.number().nonnegative().optional(),
			currency: z.string().optional(),
			timestamp: z.string().optional(),
		})
		.passthrough(),
])

function resolveAmount(data = {}) {
	if (typeof data.totalPrice === 'number') return data.totalPrice
	if (typeof data.totalAmount === 'number') return data.totalAmount
	if (typeof data.amount === 'number') return data.amount

	if (Array.isArray(data.products) && data.products.length > 0) {
		return data.products.reduce((total, product) => {
			const price = Number(product.price || 0)
			const quantity = Number(product.quantity || 0)
			return total + price * quantity
		}, 0)
	}

	return null
}

function normalizePayload(message) {
	if (message?.data) {
		const data = message.data
		return {
			rawType: message.type,
			orderId: data.orderId,
			amount: resolveAmount(data),
			currency: data.currency || message.currency || 'USD',
			products:
				data.products ||
				(data.productId
					? [
							{
								productId: data.productId,
								quantity: data.quantity ?? 1,
								price: data.price,
							},
					  ]
					: []),
		}
	}

	return {
		rawType: message.type,
		orderId: message.orderId,
		amount: resolveAmount(message),
		currency: message.currency || 'USD',
		products: message.productId
			? [
					{
						productId: message.productId,
						quantity: message.quantity ?? 1,
						price: message.price,
					},
			  ]
			: [],
	}
}

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
		async (message, metadata = {}) => {
			const normalized = normalizePayload(message)
			const correlationId = metadata.correlationId || normalized.orderId

			logger.info(
				{
					orderId: normalized.orderId,
					queue: queueName,
					correlationId,
					eventId: metadata.eventId,
				},
				'⏳ [Payment] Processing STOCK_RESERVED event'
			)

			const result = await paymentProcessor.process({
				orderId: normalized.orderId,
				amount: normalized.amount,
				currency: normalized.currency,
			})

			if (result.status === 'SUCCEEDED') {
				await publishSuccess({
					broker,
					config,
					payload: normalized,
					result,
					correlationId,
				})
			} else {
				await publishFailure({
					broker,
					config,
					payload: normalized,
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
	StockReservedEventSchema,
}

