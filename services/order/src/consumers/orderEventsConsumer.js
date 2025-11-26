const logger = require('@ecommerce/logger')
const {
	InventoryReservedSuccessSchema,
	InventoryReservedFailedSchema,
	PaymentSucceededSchema,
	PaymentFailedSchema,
} = require('../schemas/orderEvents.schema')

/**
 * Route and validate incoming events for Order Service
 * @param {object} rawMessage - Raw message from broker
 * @param {object} metadata - Message metadata (eventId, correlationId)
 * @returns {{ eventType: string, validatedMessage: object }}
 */
function parseAndValidateEvent(rawMessage, metadata = {}) {
	const { eventId, correlationId } = metadata
	const rawType = rawMessage.type || ''

	let eventType = null
	let validatedMessage = null

	// Determine event type and validate schema
	if (
		rawType === 'INVENTORY_RESERVED_SUCCESS' ||
		rawType === 'inventory.reserved.success'
	) {
		try {
			validatedMessage = InventoryReservedSuccessSchema.parse(rawMessage)
			eventType = 'INVENTORY_RESERVED_SUCCESS'
		} catch (error) {
			logger.error(
				{ error: error.message, eventId, rawMessage },
				'❌ [Order] INVENTORY_RESERVED_SUCCESS schema validation failed'
			)
			throw error
		}
	} else if (
		rawType === 'INVENTORY_RESERVED_FAILED' ||
		rawType === 'inventory.reserved.failed'
	) {
		try {
			validatedMessage = InventoryReservedFailedSchema.parse(rawMessage)
			eventType = 'INVENTORY_RESERVED_FAILED'
		} catch (error) {
			logger.error(
				{ error: error.message, eventId, rawMessage },
				'❌ [Order] INVENTORY_RESERVED_FAILED schema validation failed'
			)
			throw error
		}
	} else if (
		rawType === 'PAYMENT_SUCCEEDED' ||
		rawType === 'payment.succeeded'
	) {
		try {
			validatedMessage = PaymentSucceededSchema.parse(rawMessage)
			eventType = 'PAYMENT_SUCCEEDED'
		} catch (error) {
			logger.error(
				{ error: error.message, eventId, rawMessage },
				'❌ [Order] PAYMENT_SUCCEEDED schema validation failed'
			)
			throw error
		}
	} else if (
		rawType === 'PAYMENT_FAILED' ||
		rawType === 'payment.failed'
	) {
		try {
			validatedMessage = PaymentFailedSchema.parse(rawMessage)
			eventType = 'PAYMENT_FAILED'
		} catch (error) {
			logger.error(
				{ error: error.message, eventId, rawMessage },
				'❌ [Order] PAYMENT_FAILED schema validation failed'
			)
			throw error
		}
	} else if (
		rawType === 'PAYMENT_COMPLETED' // Backward compatibility
	) {
		try {
			validatedMessage = PaymentSucceededSchema.parse(rawMessage)
			eventType = 'PAYMENT_SUCCEEDED'
		} catch (error) {
			logger.error(
				{ error: error.message, eventId, rawMessage },
				'❌ [Order] PAYMENT_COMPLETED schema validation failed'
			)
			throw error
		}
	} else {
		const error = new Error(
			`Unknown event type: ${rawType}. Supported types: INVENTORY_RESERVED_SUCCESS, INVENTORY_RESERVED_FAILED, PAYMENT_SUCCEEDED, PAYMENT_FAILED`
		)
		logger.error(
			{ type: rawType, eventId, correlationId },
			'❌ [Order] Unknown event type, sending to DLQ'
		)
		throw error
	}

	return { eventType, validatedMessage }
}

/**
 * Register Order Events Consumer
 * 
 * This consumer handles:
 * - INVENTORY_RESERVED_SUCCESS: All inventory reserved → Confirm order
 * - INVENTORY_RESERVED_FAILED: Inventory reservation failed → Cancel order
 * - PAYMENT_SUCCEEDED: Payment processed → Mark order as PAID
 * - PAYMENT_FAILED: Payment failed → Cancel order and release inventory
 * 
 * @param {object} params
 * @param {object} params.broker - Message broker instance
 * @param {object} params.orderService - Order service instance
 * @param {object} params.idempotencyService - Idempotency service instance
 * @param {object} params.config - Configuration
 */
async function registerOrderEventsConsumer({
	broker,
	orderService,
	idempotencyService,
	config,
}) {
	const queueName = 'q.order-service'
	const routingKeys = [
		'inventory.reserved.success', // INVENTORY_RESERVED_SUCCESS
		'inventory.reserved.failed',  // INVENTORY_RESERVED_FAILED
		'payment.succeeded',          // PAYMENT_SUCCEEDED
		'payment.failed',             // PAYMENT_FAILED
	]

	await broker.consume(
		queueName,
		async (rawMessage, metadata = {}) => {
			const { eventId, correlationId } = metadata

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 1: Parse and Validate Event
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const { eventType, validatedMessage } = parseAndValidateEvent(
				rawMessage,
				metadata
			)

			const orderId = validatedMessage.orderId

			logger.info(
				{
					eventType,
					orderId,
					eventId,
					correlationId,
					queue: queueName,
				},
				`⏳ [Order] Received ${eventType} event`
			)

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 2: Idempotency Check (Redis - fast check)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const alreadyProcessed = await idempotencyService.isProcessed(
				eventType,
				orderId
			)
			if (alreadyProcessed) {
				logger.warn(
					{ eventType, orderId, eventId, correlationId },
					`⚠️ [Order] Event ${eventType} already processed for order, skipping (idempotency)`
				)
				return // Skip duplicate processing
			}

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// STEP 3: Route to appropriate handler
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			try {
				switch (eventType) {
					case 'INVENTORY_RESERVED_SUCCESS':
						await orderService.handleInventoryReserved(
							validatedMessage,
							correlationId
						)
						break

					case 'INVENTORY_RESERVED_FAILED':
						await orderService.handleInventoryReserveFailed(
							validatedMessage,
							correlationId
						)
						break

					case 'PAYMENT_SUCCEEDED':
						await orderService.handlePaymentSucceeded(
							validatedMessage,
							correlationId
						)
						break

					case 'PAYMENT_FAILED':
						await orderService.handlePaymentFailed(
							validatedMessage,
							correlationId
						)
						break

					default:
						logger.warn(
							{ eventType, orderId, correlationId },
							'⚠️ [Order] Unhandled event type (this should not happen)'
						)
						return
				}

				// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
				// STEP 4: Mark as Processed (Redis Idempotency)
				// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
				await idempotencyService.markAsProcessed(eventType, orderId)

				logger.info(
					{ eventType, orderId, eventId, correlationId },
					`✓ [Order] Successfully processed ${eventType} event`
				)
			} catch (error) {
				logger.error(
					{
						error: error.message,
						eventType,
						orderId,
						eventId,
						correlationId,
					},
					`❌ [Order] Error processing ${eventType} event`
				)
				throw error // Will be sent to DLQ by broker
			}
		},
		null, // No schema validation at broker level - we validate in handler
		routingKeys
	)

	logger.info(
		{ queue: queueName, routingKeys },
		'✓ [Order] Event consumer ready (with idempotency & schema validation)'
	)
}

module.exports = {
	registerOrderEventsConsumer,
	parseAndValidateEvent,
}
