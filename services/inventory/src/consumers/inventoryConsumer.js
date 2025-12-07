const { v4: uuidv4 } = require('uuid')
const mongoose = require('mongoose')
const logger = require('@ecommerce/logger')
const inventoryService = require('../services/inventoryService')
const {
	OrderCreatedSchema,
	OrderCancelledSchema,
	ProductCreatedSchema,
	ProductDeletedSchema,
	PaymentFailedSchema,
} = require('../schemas/inventoryEvents.schema')

// OutboxManager instance (injected from app.js)
let outboxManager = null
// IdempotencyService instance (injected from app.js)
let idempotencyService = null

/**
 * Handle ORDER_CREATED event - Reserve stock for order
 * Uses Outbox Pattern for transactional messaging
 * 
 * Supports two modes:
 * - Regular order: Full validation with business rules
 * - Seckill order: "Blind Update" - trust Redis, just do atomic DB update
 * 
 * Includes retry logic for MongoDB Write Conflicts (transient errors)
 */
async function handleOrderCreated(message, metadata = {}) {
	const { orderId, products } = message
	const orderMetadata = message.metadata || {}
	const { eventId, correlationId } = metadata
	const baseEventId = eventId || uuidv4()
	const correlatedId = correlationId || orderId

	// Check if this is a seckill order
	const isSeckill = orderMetadata.source === 'seckill'

	logger.info(
		{ orderId, productsCount: products.length, eventId, correlationId, isSeckill, source: orderMetadata.source },
		`📦 [Inventory] Handling RESERVE request (${isSeckill ? 'Seckill Blind Update' : 'Regular Batch'})`
	)

	// Retry configuration for Write Conflicts
	const MAX_RETRIES = 3
	const RETRY_DELAY_MS = 100

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		// Check idempotency BEFORE each attempt (another instance may have processed during our retry delay)
		if (idempotencyService && attempt > 1) {
			const alreadyProcessed = await idempotencyService.isProcessed('ORDER_CREATED', orderId)
			if (alreadyProcessed) {
				logger.warn(
					{ orderId, attempt, eventId, correlationId },
					`⚠️ [Inventory] ORDER_CREATED already processed by another instance during retry, skipping`
				)
				return // Another instance handled it
			}
		}

		const session = await mongoose.startSession()
		session.startTransaction()

		try {
			let result

			if (isSeckill) {
				// SECKILL LOGIC: "Blind Update" - Trust Redis, atomic DB update
				// Redis has already validated and reserved. Just sync DB state.
				result = await handleSeckillReserve(products, session, {
					orderId,
					correlationId: correlatedId,
				})
			} else {
				// REGULAR ORDER LOGIC: Full validation with business rules
				result = await inventoryService.reserveStockBatch(products, session, {
					orderId,
					correlationId: correlatedId,
				})
			}

			if (result.success) {
				await outboxManager.createEvent({
					eventType: 'INVENTORY_RESERVED_SUCCESS',
					payload: {
						type: 'INVENTORY_RESERVED_SUCCESS',
						data: {
							orderId,
							products,
							timestamp: new Date().toISOString(),
						},
					},
					session,
					eventId: `${baseEventId}:reserved`,
					correlationId: correlatedId,
					routingKey: 'inventory.reserved.success',
				})

				await session.commitTransaction()
				session.endSession()

				// Mark as processed IMMEDIATELY after commit to prevent other instances from processing
				if (idempotencyService) {
					await idempotencyService.markAsProcessed('ORDER_CREATED', orderId)
				}

				logger.info(
					{
						orderId,
						productsCount: products.length,
						routingKey: 'inventory.reserved.success',
						isSeckill,
						attempt,
					},
					`✓ [Inventory] RESERVED_SUCCESS - queued via Outbox (${isSeckill ? 'Seckill' : 'Regular'})`
				)
				return // Success - exit retry loop
			} else {
				// Rollback any partial changes
				await session.abortTransaction()
				session.endSession()

				// Create a new session for the failure event
				const failSession = await mongoose.startSession()
				failSession.startTransaction()

				try {
					await outboxManager.createEvent({
						eventType: 'INVENTORY_RESERVED_FAILED',
						payload: {
							type: 'INVENTORY_RESERVED_FAILED',
							data: {
								orderId,
								products,
								reason: result.message,
								timestamp: new Date().toISOString(),
							},
						},
						session: failSession,
						eventId: `${baseEventId}:reserve_failed`,
						correlationId: correlatedId,
						routingKey: 'inventory.reserved.failed',
					})

					await failSession.commitTransaction()

					// Mark as processed IMMEDIATELY after commit to prevent other instances from processing
					if (idempotencyService) {
						await idempotencyService.markAsProcessed('ORDER_CREATED', orderId)
					}

					logger.warn(
						{
							orderId,
							reason: result.message,
							routingKey: 'inventory.reserved.failed',
							isSeckill,
						},
						`✗ [Inventory] RESERVED_FAILED - ${isSeckill ? 'DB sync failed (Redis/DB mismatch)' : 'insufficient stock'}, queued via Outbox`
					)
				} catch (failError) {
					await failSession.abortTransaction()
					throw failError
				} finally {
					failSession.endSession()
				}
				return // Business logic failure - don't retry
			}
		} catch (error) {
			await session.abortTransaction()
			session.endSession()

			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			// Check if this is a Duplicate Key error on eventId (E11000)
			// This means another instance already processed this event successfully
			// We should treat this as SUCCESS (idempotent behavior)
			// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
			const isDuplicateKeyError = error.code === 11000 || 
				(error.message && error.message.includes('E11000 duplicate key error'))
			
			if (isDuplicateKeyError && error.message && error.message.includes(':reserved')) {
				logger.info(
					{ orderId, eventId, correlationId, error: error.message },
					`✓ [Inventory] Duplicate eventId detected - event already processed successfully by another instance, treating as SUCCESS (idempotent)`
				)
				
				// Mark as processed to prevent future duplicates
				if (idempotencyService) {
					await idempotencyService.markAsProcessed('ORDER_CREATED', orderId)
				}
				
				return // Exit successfully - another instance already handled this
			}

			// Check if this is a Write Conflict (retryable)
			const isWriteConflict = error.message && (
				error.message.includes('Write conflict') ||
				error.message.includes('WriteConflict') ||
				error.code === 112 // MongoDB WriteConflict error code
			)

			if (isWriteConflict && attempt < MAX_RETRIES) {
				logger.warn(
					{ orderId, attempt, maxRetries: MAX_RETRIES, error: error.message },
					`⚠️ [Inventory] Write conflict detected, retrying (${attempt}/${MAX_RETRIES})...`
				)
				// Exponential backoff: 100ms, 200ms, 400ms
				await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt - 1)))
				continue // Retry
			}

			// Non-retryable error or max retries exceeded
			logger.error(
				{ error: error.message, orderId, isSeckill, attempt },
				'❌ [Inventory] Error processing RESERVE request'
			)

			// Create failure event in separate transaction
			const errorSession = await mongoose.startSession()
			errorSession.startTransaction()

			try {
				await outboxManager.createEvent({
					eventType: 'INVENTORY_RESERVED_FAILED',
					payload: {
						type: 'INVENTORY_RESERVED_FAILED',
						data: {
							orderId,
							products,
							reason: error.message,
							timestamp: new Date().toISOString(),
						},
					},
					session: errorSession,
					eventId: `${baseEventId}:reserve_error`,
					correlationId: correlatedId,
					routingKey: 'inventory.reserved.failed',
				})

				await errorSession.commitTransaction()

				// Mark as processed after commit to prevent other instances from processing
				if (idempotencyService) {
					await idempotencyService.markAsProcessed('ORDER_CREATED', orderId)
				}
			} catch (outboxError) {
				// Check if this outbox creation also failed due to duplicate key
				// This means the error event was already created - safe to ignore
				const isOutboxDuplicate = outboxError.code === 11000 || 
					(outboxError.message && outboxError.message.includes('E11000 duplicate key error'))
				
				if (isOutboxDuplicate) {
					logger.warn(
						{ orderId, error: outboxError.message },
						'⚠️ [Inventory] Outbox error event already exists (duplicate), ignoring'
					)
				} else {
					await errorSession.abortTransaction()
					logger.error(
						{ error: outboxError.message, orderId },
						'❌ [Inventory] Failed to create outbox event for error'
					)
				}
			} finally {
				errorSession.endSession()
			}
			return // Exit after handling error
		}
	} // End of retry loop
}

/**
 * Handle Seckill Reserve - "Blind Update" mode
 * 
 * For seckill orders, we trust Redis has already done the validation.
 * We just need to atomically update DB to keep it in sync.
 * 
 * Uses optimistic update: UPDATE WHERE available >= quantity
 * If this fails, it means Redis and DB are out of sync (rare edge case)
 * 
 * @param {Array} products - Array of {productId, quantity}
 * @param {Object} session - MongoDB session for transaction
 * @param {Object} options - {orderId, correlationId}
 * @returns {Object} - {success: boolean, message: string}
 */
async function handleSeckillReserve(products, session, options = {}) {
	const { orderId, correlationId } = options
	const Inventory = require('../models/inventory')

	logger.info(
		{ orderId, products, correlationId },
		'🎯 [Inventory] Seckill Blind Update - Starting atomic DB sync'
	)

	try {
		for (const product of products) {
			const { productId, quantity } = product

			// Atomic update: Decrement available, increment reserved
			// Only succeeds if available >= quantity (prevents negative stock)
			const result = await Inventory.updateOne(
				{
					productId: productId,
					available: { $gte: quantity },
				},
				{
					$inc: {
						available: -quantity,
						reserved: quantity,
					},
				},
				{ session }
			)

			if (result.modifiedCount === 0) {
				// DB is out of sync with Redis - this is a rare edge case
				logger.error(
					{ orderId, productId, quantity, correlationId },
					'❌ [Inventory] Seckill Blind Update FAILED - DB out of sync with Redis'
				)
				return {
					success: false,
					message: `DB_OUT_OF_STOCK: Product ${productId} has insufficient stock in DB (Redis/DB mismatch)`,
				}
			}

			logger.info(
				{ orderId, productId, quantity, correlationId },
				'✓ [Inventory] Seckill Blind Update - DB stock decremented'
			)
		}

		return {
			success: true,
			message: 'Seckill blind update completed successfully',
		}
	} catch (error) {
		logger.error(
			{ error: error.message, orderId, correlationId },
			'❌ [Inventory] Seckill Blind Update error'
		)

		// Check if this is a Write Conflict (retryable error)
		// Re-throw to allow caller's retry logic to handle it
		const isWriteConflict =
			error.message &&
			(error.message.includes('Write conflict') ||
				error.message.includes('WriteConflict') ||
				error.code === 112)

		if (isWriteConflict) {
			logger.warn(
				{ orderId, correlationId, error: error.message },
				'⚠️ [Inventory] Seckill Blind Update - Write conflict detected, re-throwing for retry'
			)
			throw error // Let caller handle retry
		}

		return {
			success: false,
			message: error.message,
		}
	}
}

/**
 * Handle ORDER_CANCELLED event - Release reserved stock
 */
async function handleOrderCancelled(message, metadata = {}) {
	const { orderId, products, reason } = message
	const { eventId, correlationId } = metadata

	logger.info(
		{ orderId, productsCount: products?.length, reason, eventId, correlationId },
		'🔓 [Inventory] Handling ORDER_CANCELLED - Releasing reserved stock'
	)

	try {
		if (!products || products.length === 0) {
			logger.warn(
				{ orderId },
				'⚠️ [Inventory] ORDER_CANCELLED received but no products to release'
			)
			return
		}

		for (const product of products) {
			try {
				await inventoryService.releaseReserved(
					product.productId,
					product.quantity,
					{ orderId, correlationId, reason: 'ORDER_CANCEL' }
				)
				logger.info(
					{
						orderId,
						productId: product.productId,
						quantity: product.quantity,
					},
					'✓ [Inventory] Released stock for cancelled order'
				)
			} catch (error) {
				logger.error(
					{
						error: error.message,
						orderId,
						productId: product.productId,
					},
					'❌ [Inventory] Error releasing stock for product'
				)
			}
		}

		logger.info(
			{ orderId, productsCount: products.length },
			'✓ [Inventory] All stock released for cancelled order'
		)
	} catch (error) {
		logger.error(
			{ error: error.message, orderId },
			'❌ [Inventory] Error processing ORDER_CANCELLED'
		)
	}
}

/**
 * Handle PRODUCT_CREATED event
 */
async function handleProductCreated(message, metadata = {}) {
	const { productId, available } = message
	const { eventId, correlationId } = metadata

	logger.info(
		{ productId, available, eventId, correlationId },
		'📦 [Inventory] Handling PRODUCT_CREATED event'
	)

	try {
		await inventoryService.createInventory(productId, available)
		logger.info(
			{ productId, available },
			'✓ [Inventory] Created inventory for product'
		)
	} catch (error) {
		logger.error(
			{ error: error.message, productId },
			'❌ [Inventory] Error handling PRODUCT_CREATED'
		)
	}
}

/**
 * Handle PRODUCT_DELETED event
 */
async function handleProductDeleted(message, metadata = {}) {
	const { productId } = message
	const { eventId, correlationId } = metadata

	logger.info(
		{ productId, eventId, correlationId },
		'🗑️ [Inventory] Handling PRODUCT_DELETED event'
	)

	try {
		await inventoryService.deleteInventory(productId)
		logger.info({ productId }, '✓ [Inventory] Deleted inventory for product')
	} catch (error) {
		logger.error(
			{ error: error.message, productId },
			'❌ [Inventory] Error handling PRODUCT_DELETED'
		)
	}
}

/**
 * Handle PAYMENT_FAILED event (Compensation - auto release stock)
 */
async function handlePaymentFailed(message, metadata = {}) {
	const { orderId, products, reason } = message
	const { eventId, correlationId } = metadata

	logger.warn(
		{ orderId, reason, eventId, correlationId },
		'💳 [Inventory] Handling PAYMENT_FAILED - Starting compensation (release stock)'
	)

	try {
		if (!products || products.length === 0) {
			logger.warn(
				{ orderId },
				'⚠️ [Inventory] PAYMENT_FAILED received but no products to release'
			)
			return
		}

		for (const product of products) {
			try {
				await inventoryService.releaseReserved(
					product.productId,
					product.quantity,
					{ orderId, correlationId, reason: 'PAYMENT_FAILED' }
				)
				logger.info(
					{
						orderId,
						productId: product.productId,
						quantity: product.quantity,
					},
					'✓ [Inventory] Released stock (compensation)'
				)
			} catch (error) {
				logger.error(
					{
						error: error.message,
						orderId,
						productId: product.productId,
					},
					'❌ [Inventory] Error releasing stock for product'
				)
			}
		}

		logger.info(
			{ orderId, productsCount: products.length },
			'✓ [Inventory] Compensation completed - all stock released'
		)
	} catch (error) {
		logger.error(
			{ error: error.message, orderId },
			'❌ [Inventory] Error processing PAYMENT_FAILED compensation'
		)
	}
}

/**
 * Route inventory events to appropriate handlers
 * Includes idempotency check to prevent duplicate processing
 */
async function routeInventoryEvent(rawMessage, metadata = {}) {
	const { eventId, correlationId, routingKey } = metadata
	
	// Try to determine event type from multiple sources:
	// 1. rawMessage.type (explicit type field)
	// 2. rawMessage.rawType (transformed type)
	// 3. metadata.routingKey (from message headers)
	const rawType = rawMessage?.type || rawMessage?.rawType || routingKey

	let validatedMessage
	let eventType
	let idempotencyKey // Used for idempotency check (orderId or productId)

	// Validate and identify event type
	if (rawType === 'ORDER_CREATED' || rawType === 'order.created') {
		try {
			validatedMessage = OrderCreatedSchema.parse(rawMessage)
			eventType = 'ORDER_CREATED'
			idempotencyKey = validatedMessage.orderId
		} catch (error) {
			logger.error(
				{ error: error.message, rawMessage },
				'❌ [Inventory] ORDER_CREATED schema validation failed'
			)
			throw error
		}
	} else if (rawType === 'ORDER_CANCELLED' || rawType === 'order.cancelled') {
		try {
			validatedMessage = OrderCancelledSchema.parse(rawMessage)
			eventType = 'ORDER_CANCELLED'
			idempotencyKey = validatedMessage.orderId
		} catch (error) {
			logger.error(
				{ error: error.message, rawMessage },
				'❌ [Inventory] ORDER_CANCELLED schema validation failed'
			)
			throw error
		}
	} else if (
		rawType === 'PRODUCT_CREATED' ||
		rawType === 'product.product.created'
	) {
		try {
			validatedMessage = ProductCreatedSchema.parse(rawMessage)
			eventType = 'PRODUCT_CREATED'
			idempotencyKey = validatedMessage.productId
		} catch (error) {
			logger.error(
				{ error: error.message, rawMessage },
				'❌ [Inventory] PRODUCT_CREATED schema validation failed'
			)
			throw error
		}
	} else if (
		rawType === 'PRODUCT_DELETED' ||
		rawType === 'product.product.deleted'
	) {
		try {
			validatedMessage = ProductDeletedSchema.parse(rawMessage)
			eventType = 'PRODUCT_DELETED'
			idempotencyKey = validatedMessage.productId
		} catch (error) {
			logger.error(
				{ error: error.message, rawMessage },
				'❌ [Inventory] PRODUCT_DELETED schema validation failed'
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
			idempotencyKey = validatedMessage.orderId
		} catch (error) {
			logger.error(
				{ error: error.message, rawMessage },
				'❌ [Inventory] PAYMENT_FAILED schema validation failed'
			)
			throw error
		}
	} else {
		const error = new Error(
			`Unknown event type: ${rawType}. Supported types: ORDER_CREATED, ORDER_CANCELLED, PRODUCT_CREATED, PRODUCT_DELETED, PAYMENT_FAILED`
		)
		logger.error(
			{ type: rawType, rawMessage },
			'❌ [Inventory] Unknown event type, sending to DLQ'
		)
		throw error
	}

	logger.info(
		{ eventType, idempotencyKey, eventId, correlationId },
		`⏳ [Inventory] Received ${eventType} event`
	)

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Idempotency Check (Redis - fast check)
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	if (idempotencyService) {
		const alreadyProcessed = await idempotencyService.isProcessed(
			eventType,
			idempotencyKey
		)
		if (alreadyProcessed) {
			logger.warn(
				{ eventType, idempotencyKey, eventId, correlationId },
				`⚠️ [Inventory] Event ${eventType} already processed, skipping (idempotency)`
			)
			return // Skip duplicate processing
		}
	}

	// Route to appropriate handler
	try {
		switch (eventType) {
			case 'ORDER_CREATED':
				await handleOrderCreated(validatedMessage, metadata)
				break
			case 'ORDER_CANCELLED':
				await handleOrderCancelled(validatedMessage, metadata)
				break
			case 'PRODUCT_CREATED':
				await handleProductCreated(validatedMessage, metadata)
				break
			case 'PRODUCT_DELETED':
				await handleProductDeleted(validatedMessage, metadata)
				break
			case 'PAYMENT_FAILED':
				await handlePaymentFailed(validatedMessage, metadata)
				break
		}

		// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
		// Mark as Processed (Redis Idempotency)
		// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
		if (idempotencyService) {
			await idempotencyService.markAsProcessed(eventType, idempotencyKey)
		}

		logger.info(
			{ eventType, idempotencyKey, eventId, correlationId },
			`✓ [Inventory] Successfully processed ${eventType} event`
		)
	} catch (error) {
		logger.error(
			{ error: error.message, eventType, idempotencyKey, eventId, correlationId },
			`❌ [Inventory] Error processing ${eventType} event`
		)
		throw error // Will be sent to DLQ by broker
	}
}

/**
 * Register inventory consumer
 * @param {Object} broker - Message broker instance
 * @param {Object} outbox - OutboxManager instance for transactional messaging
 * @param {Object} idempotency - IdempotencyService instance for duplicate prevention
 */
async function registerInventoryConsumer(broker, outbox, idempotency) {
	// Store instances for use in handlers
	outboxManager = outbox
	idempotencyService = idempotency

	const queueName = 'q.inventory-service'
	const routingKeys = [
		'order.created',   // ORDER_CREATED - Reserve stock
		'order.cancelled', // ORDER_CANCELLED - Release stock
		'payment.failed',  // PAYMENT_FAILED - Compensation (release stock)
	]

	await broker.consume(
		queueName,
		async (rawMessage, metadata) => {
			await routeInventoryEvent(rawMessage, metadata)
		},
		null,
		routingKeys
	)

	logger.info(
		{ queue: queueName, routingKeys },
		'✓ [Inventory] Consumer ready with Outbox Pattern & Idempotency (Event-Driven: ORDER_CREATED, ORDER_CANCELLED, PAYMENT_FAILED)'
	)
}

module.exports = {
	registerInventoryConsumer,
	handleOrderCreated,
	handleOrderCancelled,
	handleProductCreated,
	handleProductDeleted,
	handlePaymentFailed,
	routeInventoryEvent,
}
