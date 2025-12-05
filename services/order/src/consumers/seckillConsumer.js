const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')
const logger = require('@ecommerce/logger')
const { z } = require('zod')

// Schema for seckill.order.won event validation
const SeckillOrderWonSchema = z
	.object({
		userId: z.string().min(1, 'userId is required'),
		productId: z.string().min(1, 'productId is required'),
		price: z.number().positive('price must be positive'),
		quantity: z.number().int().positive().default(1),
		timestamp: z.number().int().optional(),
		metadata: z
			.object({
				source: z.literal('seckill'),
				campaignId: z.string().optional(),
			})
			.optional(),
	})
	.passthrough()

// Module-level references (injected at registration)
let outboxManager = null
let orderRepository = null

/**
 * Handle seckill.order.won event
 * Creates a new order in PENDING state with seckill metadata
 * 
 * Flow:
 * 1. Validate incoming event
 * 2. Create order with status: PENDING, metadata: { source: 'seckill' }
 * 3. Publish ORDER_CREATED event via Outbox
 * 
 * @param {Object} message - Event data from seckill service
 * @param {Object} metadata - Event metadata (eventId, correlationId)
 */
async function handleSeckillOrderWon(message, metadata = {}) {
	const { eventId, correlationId } = metadata
	const baseCorrelationId = correlationId || uuidv4()

	logger.info(
		{ message, eventId, correlationId: baseCorrelationId },
		'🎯 [Order] Handling seckill.order.won event'
	)

	// Validate message schema
	let validated
	try {
		validated = SeckillOrderWonSchema.parse(message)
	} catch (error) {
		logger.error(
			{ error: error.message, message },
			'❌ [Order] seckill.order.won schema validation failed'
		)
		throw error
	}

	const { userId, productId, price, quantity = 1 } = validated

	const session = await mongoose.startSession()
	session.startTransaction()

	try {
		// Create order data with seckill metadata
		const orderData = {
			products: [
				{
					_id: new mongoose.Types.ObjectId(productId),
					name: 'Seckill Product', // Placeholder - could be fetched if needed
					price: price,
					description: 'Flash sale product',
					quantity: quantity,
					reserved: false,
				},
			],
			user: userId,
			totalPrice: price * quantity,
			status: 'PENDING',
			metadata: {
				source: 'seckill',
				seckillRef: eventId || uuidv4(), // Reference to original seckill event
			},
		}

		// Create order using repository
		const order = await orderRepository.create(orderData, session)
		const orderId = order._id.toString()

		logger.info(
			{ orderId, userId, productId, source: 'seckill', correlationId: baseCorrelationId },
			'✓ [Order] Created seckill order with PENDING status'
		)

		// Create ORDER_CREATED event via Outbox Pattern
		const timestamp = new Date().toISOString()
		await outboxManager.createEvent({
			eventType: 'ORDER_CREATED',
			payload: {
				type: 'ORDER_CREATED',
				data: {
					orderId,
					products: order.products.map((product) => ({
						productId: product._id.toString(),
						quantity: product.quantity,
					})),
					// Pass metadata to Inventory Service for "blind update" logic
					metadata: {
						source: 'seckill',
						seckillRef: order.metadata.seckillRef,
					},
				},
				timestamp,
			},
			session,
			correlationId: baseCorrelationId,
			routingKey: 'order.created',
		})

		await session.commitTransaction()

		logger.info(
			{ orderId, userId, productId, correlationId: baseCorrelationId },
			'✓ [Order] Seckill order created and ORDER_CREATED event queued via Outbox'
		)

		return { orderId, success: true }
	} catch (error) {
		await session.abortTransaction()
		logger.error(
			{ error: error.message, userId, productId, correlationId: baseCorrelationId },
			'❌ [Order] Failed to create seckill order, transaction rolled back'
		)
		throw error
	} finally {
		session.endSession()
	}
}

/**
 * Register seckill consumer with message broker
 * 
 * @param {Object} params - Registration parameters
 * @param {Object} params.broker - Message broker instance
 * @param {Object} params.outbox - OutboxManager instance
 * @param {Object} params.repository - Order repository instance
 * @param {Object} params.idempotencyService - Idempotency service instance
 */
async function registerSeckillConsumer({
	broker,
	outbox,
	repository,
	idempotencyService,
}) {
	// Store instances for use in handlers
	outboxManager = outbox
	orderRepository = repository

	const queueName = 'q.order-seckill'
	const routingKeys = ['seckill.order.won']

	await broker.consume(
		queueName,
		async (rawMessage, metadata = {}) => {
			const { eventId, correlationId } = metadata

			// Idempotency check
			const idempotencyKey = `seckill:${rawMessage.userId}:${rawMessage.productId}:${rawMessage.timestamp || Date.now()}`
			
			if (idempotencyService) {
				const alreadyProcessed = await idempotencyService.isProcessed(
					'SECKILL_ORDER_WON',
					idempotencyKey
				)
				if (alreadyProcessed) {
					logger.warn(
						{ eventId, correlationId, idempotencyKey },
						'⚠️ [Order] seckill.order.won already processed, skipping (idempotency)'
					)
					return
				}
			}

			try {
				await handleSeckillOrderWon(rawMessage, metadata)

				// Mark as processed
				if (idempotencyService) {
					await idempotencyService.markAsProcessed(
						'SECKILL_ORDER_WON',
						idempotencyKey
					)
				}

				logger.info(
					{ eventId, correlationId },
					'✓ [Order] seckill.order.won processed successfully'
				)
			} catch (error) {
				logger.error(
					{ error: error.message, eventId, correlationId },
					'❌ [Order] Error processing seckill.order.won event'
				)
				throw error // Will be sent to DLQ by broker
			}
		},
		null, // No schema validation at broker level
		routingKeys
	)

	logger.info(
		{ queue: queueName, routingKeys },
		'✓ [Order] Seckill consumer ready (Event-Driven: seckill.order.won)'
	)
}

module.exports = {
	registerSeckillConsumer,
	handleSeckillOrderWon,
	SeckillOrderWonSchema,
}
