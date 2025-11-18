// Initialize OpenTelemetry FIRST (before any other imports)
const { initTracing } = require("@ecommerce/tracing");

// Initialize tracing with service name and Jaeger endpoint
const jaegerEndpoint = process.env.JAEGER_ENDPOINT || "http://localhost:4318/v1/traces";
initTracing("inventory-service", jaegerEndpoint);

// Load config BEFORE logger to ensure NODE_ENV is set
require("@ecommerce/config");

// Now import other modules
const app = require('./src/app')
const config = require('./src/config')
const mongoose = require('mongoose')
const logger = require('@ecommerce/logger')
const { v4: uuidv4 } = require('uuid')
const inventoryService = require('./src/services/inventoryService')
const {
	ReserveRequestSchema,
	ReleaseRequestSchema,
	ProductCreatedSchema,
	ProductDeletedSchema,
	PaymentFailedSchema,
} = require('./src/schemas/inventoryEvents.schema')

const PORT = config.port

let broker = null

/**
 * Handle RESERVE request event
 */
async function handleReserveRequest(message, metadata = {}) {
	const { orderId, productId, quantity } = message
	const { eventId, correlationId } = metadata
	const baseEventId = eventId || uuidv4()
	const correlatedId = correlationId || orderId

	logger.info(
		{ orderId, productId, quantity, eventId, correlationId },
		'📦 [Inventory] Handling RESERVE request'
	)

	try {
		const result = await inventoryService.reserveStock(productId, quantity)

		if (result.success) {
			await broker.publish(
				'orders',
				{
					type: 'INVENTORY_RESERVED',
					data: {
						orderId,
						productId,
						quantity,
						timestamp: new Date().toISOString(),
					},
				},
				{
					eventId: `${baseEventId}:reserved`,
					correlationId: correlatedId,
				}
			)

			logger.info(
				{ orderId, productId, quantity },
				'✓ [Inventory] RESERVED - published to orders queue'
			)
		} else {
			await broker.publish(
				'orders',
				{
					type: 'INVENTORY_RESERVE_FAILED',
					data: {
						orderId,
						productId,
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
				{ orderId, productId, reason: result.message },
				'✗ [Inventory] RESERVE_FAILED - insufficient stock'
			)
		}
	} catch (error) {
		logger.error(
			{ error: error.message, orderId, productId },
			'❌ [Inventory] Error processing RESERVE request'
		)

		await broker.publish(
			'orders',
			{
				type: 'INVENTORY_RESERVE_FAILED',
				data: {
					orderId,
					productId,
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
 * Handle RELEASE request event
 */
async function handleReleaseRequest(message, metadata = {}) {
	const { orderId, productId, quantity } = message
	const { eventId, correlationId } = metadata
	const baseEventId = eventId || uuidv4()
	const correlatedId = correlationId || orderId

	logger.info(
		{ orderId, productId, quantity, eventId, correlationId },
		'🔓 [Inventory] Handling RELEASE request'
	)

	try {
		await inventoryService.releaseReserved(productId, quantity)

		await broker.publish(
			'orders',
			{
				type: 'INVENTORY_RELEASED',
				data: {
					orderId,
					productId,
					quantity,
					timestamp: new Date().toISOString(),
				},
			},
			{
				eventId: `${baseEventId}:released`,
				correlationId: correlatedId,
			}
		)

		logger.info(
			{ orderId, productId, quantity },
			'✓ [Inventory] RELEASED - published to orders queue'
		)
	} catch (error) {
		logger.error(
			{ error: error.message, orderId, productId },
			'❌ [Inventory] Error processing RELEASE request'
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
		// Don't throw - just log error and continue
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

		// Release stock for all products in the order
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
				// Continue with other products even if one fails
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
 * Connect to MongoDB with retry logic
 */
async function connectDB(retries = 5, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await mongoose.connect(config.mongoURI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
      });
      console.log("✓ [Inventory] MongoDB connected");
      logger.info({ mongoURI: config.mongoURI }, "MongoDB connected");
      return;
    } catch (err) {
      logger.error({ error: err.message }, `MongoDB connection failed (Attempt ${i}/${retries})`);
      if (i < retries) {
        await new Promise((res) => setTimeout(res, delay));
      } else {
        logger.error("Could not connect to MongoDB after all retries. Exiting.");
        process.exit(1);
      }
    }
  }
}

/**
 * Start the server
 */
async function startServer() {
  try {
    // Log starting message (OUTSIDE callback like auth service)
    logger.info("Starting inventory service...");

    // Start Express server first (like other services)
    app.listen(PORT, () => {
      console.log(`✓ [Inventory] Server started on port ${PORT}`);
      console.log(`✓ [Inventory] Ready`);
      logger.info({ port: PORT }, "Inventory service ready");
    });

    // Connect to MongoDB
    await connectDB();
		// Connect to RabbitMQ broker using @ecommerce/message-broker
		const { Broker } = await import('@ecommerce/message-broker')
		broker = new Broker()
		logger.info('✓ [Inventory] Broker initialized')

		// Unified handler that routes messages based on type with schema validation
		async function routeInventoryEvent(rawMessage, metadata = {}) {
			const rawType = rawMessage?.type || rawMessage?.rawType

			// Try to identify event type and validate with appropriate schema
			let validatedMessage
			let eventType

			// Try RESERVE
			if (
				rawType === 'INVENTORY_RESERVE_REQUEST' ||
				rawType === 'RESERVE' ||
				rawType === 'order.inventory.reserve'
			) {
				try {
					validatedMessage = ReserveRequestSchema.parse(rawMessage)
					eventType = 'RESERVE'
				} catch (error) {
					logger.error(
						{ error: error.message, rawMessage },
						'❌ [Inventory] RESERVE schema validation failed'
					)
					throw error
				}
			}
			// Try RELEASE
			else if (
				rawType === 'INVENTORY_RELEASE_REQUEST' ||
				rawType === 'RELEASE' ||
				rawType === 'order.inventory.release'
			) {
				try {
					validatedMessage = ReleaseRequestSchema.parse(rawMessage)
					eventType = 'RELEASE'
				} catch (error) {
					logger.error(
						{ error: error.message, rawMessage },
						'❌ [Inventory] RELEASE schema validation failed'
					)
					throw error
				}
			}
			// Try PRODUCT_CREATED
			else if (
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
			}
			// Try PRODUCT_DELETED
			else if (
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
			}
			// Try PAYMENT_FAILED
			else if (
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
			}
			// Unknown type - throw error to send to DLQ
			else {
				const error = new Error(
					`Unknown event type: ${rawType}. Supported types: RESERVE, RELEASE, PRODUCT_CREATED, PRODUCT_DELETED, PAYMENT_FAILED`
				)
				logger.error(
					{ type: rawType, rawMessage },
					'❌ [Inventory] Unknown event type, sending to DLQ'
				)
				throw error
			}

			// Route to appropriate handler
			switch (eventType) {
				case 'RESERVE':
					await handleReserveRequest(validatedMessage, metadata)
					break
				case 'RELEASE':
					await handleReleaseRequest(validatedMessage, metadata)
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

		// Single consumer that routes and validates all event types
		await broker.consume('inventory', routeInventoryEvent)
		logger.info(
			'✓ [Inventory] Consumer ready on "inventory" queue (handles: RESERVE, RELEASE, PRODUCT_CREATED, PRODUCT_DELETED, PAYMENT_FAILED)'
		)
	} catch (error) {
		logger.error({ error: error.message }, 'Failed to start server')
		process.exit(1)
	}
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  await mongoose.connection.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT signal received: closing HTTP server");
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
