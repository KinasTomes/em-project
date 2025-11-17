// packages/outbox-pattern/models/OutboxModel.js

import mongoose from 'mongoose'

/**
 * Shared Outbox Schema
 *
 * Used by all services to store events before publishing to RabbitMQ.
 * Ensures at-least-once delivery guarantee via MongoDB transactions.
 */
const outboxSchema = new mongoose.Schema(
	{
		// Event metadata
		eventType: {
			type: String,
			required: true,
			index: true,
			description: 'Type of event (e.g., ORDER_CREATED, STOCK_RESERVED)',
		},

		// Event data
		payload: {
			type: mongoose.Schema.Types.Mixed,
			required: true,
			description: 'Event payload (JSON object)',
		},

		// Unique identifiers
		eventId: {
			type: String,
			required: true,
			unique: true,
			index: true,
			description: 'Unique event ID for idempotency',
		},

		correlationId: {
			type: String,
			required: true,
			index: true,
			description: 'Correlation ID for distributed tracing',
		},

		// Optional destination queue / topic
		destination: {
			type: String,
			required: false,
			description: 'Target queue or routing key for publishers',
		},

		// Processing status
		status: {
			type: String,
			enum: ['PENDING', 'PUBLISHED', 'FAILED'],
			default: 'PENDING',
			index: true,
			description: 'Processing status of the event',
		},

		// Retry mechanism
		retries: {
			type: Number,
			default: 0,
			description: 'Number of retry attempts',
		},

		nextRetry: {
			type: Date,
			index: true,
			description: 'Timestamp for next retry attempt',
		},

		// Publishing metadata
		publishedAt: {
			type: Date,
			description: 'Timestamp when event was successfully published',
		},

		// Error tracking
		error: {
			type: String,
			description: 'Error message if publishing failed',
		},

		// Timestamps
		createdAt: {
			type: Date,
			default: Date.now,
			index: true,
			description: 'Timestamp when event was created',
		},
	},
	{
		timestamps: false, // We handle createdAt manually
		collection: 'outbox', // Collection name (will be prefixed by service name)
	}
)

// Indexes for performance
outboxSchema.index({ status: 1, createdAt: 1 })
outboxSchema.index({ status: 1, nextRetry: 1 })
outboxSchema.index({ correlationId: 1, createdAt: -1 })

/**
 * Factory function to create Outbox model for specific service
 *
 * @param {string} serviceName - Name of the service (e.g., 'order', 'inventory')
 * @param {mongoose.Connection} connection - Mongoose connection (optional)
 * @returns {mongoose.Model} Outbox model
 *
 * @example
 * import { createOutboxModel } from '@ecommerce/outbox-pattern';
 *
 * const OrderOutbox = createOutboxModel('order');
 * await OrderOutbox.create({
 *   eventType: 'ORDER_CREATED',
 *   payload: { orderId: '123' },
 *   eventId: uuid(),
 *   correlationId: uuid()
 * });
 */
export function createOutboxModel(serviceName, connection = mongoose) {
	const modelName = `${serviceName}_outbox`
	const collectionName = `${serviceName}_outbox`

	// Check if model already exists
	if (connection.models[modelName]) {
		return connection.models[modelName]
	}

	// Create new model with service-specific name
	const OutboxModel = connection.model(modelName, outboxSchema, collectionName)

	return OutboxModel
}

/**
 * Helper function to create outbox event
 *
 * @param {mongoose.Model} OutboxModel - Outbox model
 * @param {string} eventType - Event type
 * @param {object} payload - Event payload
 * @param {string} eventId - Unique event ID
 * @param {string} correlationId - Correlation ID for tracing
 * @param {mongoose.ClientSession} session - MongoDB session for transaction
 * @returns {Promise<object>} Created outbox event
 *
 * @example
 * const session = await mongoose.startSession();
 * session.startTransaction();
 *
 * try {
 *   await Order.create([{ ... }], { session });
 *   await createOutboxEvent(OrderOutbox, 'ORDER_CREATED', { orderId }, eventId, correlationId, session);
 *   await session.commitTransaction();
 * } catch (error) {
 *   await session.abortTransaction();
 *   throw error;
 * } finally {
 *   session.endSession();
 * }
 */
export async function createOutboxEvent(
	OutboxModel,
	eventType,
	payload,
	eventId,
	correlationId,
	session,
	destination = null
) {
	const outboxEvent = await OutboxModel.create(
		[
			{
				eventType,
				payload,
				eventId,
				correlationId,
				destination,
				status: 'PENDING',
				retries: 0,
				createdAt: new Date(),
			},
		],
		{ session }
	)

	return outboxEvent[0]
}

export default outboxSchema
