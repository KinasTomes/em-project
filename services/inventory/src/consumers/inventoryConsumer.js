const { v4: uuidv4 } = require('uuid')
const logger = require('@ecommerce/logger')
const inventoryService = require('../services/inventoryService')
const {
	OrderCreatedSchema,
	OrderCancelledSchema,
	ProductCreatedSchema,
	ProductDeletedSchema,
	PaymentFailedSchema,
} = require('../schemas/inventoryEvents.schema')

/**
 * Handle ORDER_CREATED event - Reserve stock for order
 */
async function handleOrderCreated(message, metadata = {}, broker) {
	const { orderId, products } = message
	const { eventId, correlationId } = metadata
	const baseEventId = eventId || uuidv4()
	const correlatedId = correlationId || orderId

	logger.info(
		{ orderId, productsCount: products.length, eventId, correlationId },
		'📦 [Inventory] Handling RESERVE request (Batch)'
	)

	try {
		const result = await inventoryService.reserveStockBatch(products)

		if (result.success) {
			await broker.publish(
				'inventory.reserved.success',
				{
					type: 'INVENTORY_RESERVED_SUCCESS',
					data: {
						orderId,
						products,
						timestamp: new Date().toISOString(),
					},
				},
				{
					eventId: `${baseEventId}:reserved`,
					correlationId: correlatedId,
				}
			)

			logger.info(
				{
					orderId,
					productsCount: products.length,
					routingKey: 'inventory.reserved.success',
				},
				'✓ [Inventory] RESERVED_SUCCESS - published with routing key'
			)
		} else {
			await broker.publish(
				'inventory.reserved.failed',
				{
					type: 'INVENTORY_RESERVED_FAILED',
					data: {
						orderId,
						products,
						reason: result.message,
						timestamp: new Date().toISOString(),
					},
				},
				{
					eventId: `${baseEventId}:reserve_failed`,
					correlationId: correlatedId,
				}
			)

			logger.warn(
				{
					orderId,
					reason: result.message,
					routingKey: 'inventory.reserved.failed',
				},
				'✗ [Inventory] RESERVED_FAILED - insufficient stock'
			)
		}
	} catch (error) {
		logger.error(
			{ error: error.message, orderId },
			'❌ [Inventory] Error processing RESERVE request'
		)

		await broker.publish(
			'inventory.reserved.failed',
			{
				type: 'INVENTORY_RESERVED_FAILED',
				data: {
					orderId,
					products,
					reason: error.message,
					timestamp: new Date().toISOString(),
				},
			},
			{
				eventId: `${baseEventId}:reserve_error`,
				correlationId: correlatedId,
			}
		)
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
					product.quantity
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
					product.quantity
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
 */
async function routeInventoryEvent(rawMessage, metadata = {}, broker) {
	const rawType = rawMessage?.type || rawMessage?.rawType

	let validatedMessage
	let eventType

	// Validate and identify event type
	if (rawType === 'ORDER_CREATED' || rawType === 'order.created') {
		try {
			validatedMessage = OrderCreatedSchema.parse(rawMessage)
			eventType = 'ORDER_CREATED'
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
		} catch (error) {
			logger.error(
				{ error: error.message, rawMessage },
				'❌ [Inventory] PRODUCT_DELETED schema validation failed'
			)
			throw error
		}
	} else if (
		rawType === 'PAYMENT_FAILED' ||
		rawType === 'payment.order.failed'
	) {
		try {
			validatedMessage = PaymentFailedSchema.parse(rawMessage)
			eventType = 'PAYMENT_FAILED'
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

	// Route to appropriate handler
	switch (eventType) {
		case 'ORDER_CREATED':
			await handleOrderCreated(validatedMessage, metadata, broker)
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
}

/**
 * Register inventory consumer
 */
async function registerInventoryConsumer(broker) {
	const queueName = 'q.inventory-service'
	const routingKeys = [
		'order.created',   // ORDER_CREATED - Reserve stock
		'order.cancelled', // ORDER_CANCELLED - Release stock
		'payment.failed',  // PAYMENT_FAILED - Compensation (release stock)
	]

	await broker.consume(
		queueName,
		async (rawMessage, metadata) => {
			await routeInventoryEvent(rawMessage, metadata, broker)
		},
		null,
		routingKeys
	)

	logger.info(
		{ queue: queueName, routingKeys },
		'✓ [Inventory] Consumer ready (Event-Driven: ORDER_CREATED, ORDER_CANCELLED, PAYMENT_FAILED)'
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
