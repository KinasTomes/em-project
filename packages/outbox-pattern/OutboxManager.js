// packages/outbox-pattern/OutboxManager.js

import mongoose from 'mongoose'
import { v4 as uuid } from 'uuid'
import { trace, context } from '@opentelemetry/api'
import logger from '@ecommerce/logger'
import { createOutboxModel, createOutboxEvent } from './models/OutboxModel.js'
import { OutboxProcessor } from './processors/OutboxProcessor.js'

/**
 * Outbox Manager - High-level wrapper for Outbox Pattern
 *
 * Combines model creation, event creation, and processor management
 * into a single convenient API.
 *
 * @example
 * import { OutboxManager } from '@ecommerce/outbox-pattern';
 *
 * // Initialize
 * const outbox = new OutboxManager('order');
 * await outbox.startProcessor();
 *
 * // Create order with outbox event
 * const session = await mongoose.startSession();
 * session.startTransaction();
 *
 * try {
 *   const order = await Order.create([{ ... }], { session });
 *
 *   await outbox.createEvent({
 *     eventType: 'ORDER_CREATED',
 *     payload: { orderId: order[0]._id },
 *     session
 *   });
 *
 *   await session.commitTransaction();
 * } catch (error) {
 *   await session.abortTransaction();
 *   throw error;
 * } finally {
 *   session.endSession();
 * }
 */
export class OutboxManager {
	constructor(serviceName, connection = mongoose) {
		this.serviceName = serviceName
		this.connection = connection
		this.OutboxModel = createOutboxModel(serviceName, connection)
		this.processor = null

		logger.info({ serviceName }, 'OutboxManager initialized')
	}

	/**
	 * Create an outbox event (with auto-generated IDs)
	 *
	 * @param {object} options - Event options
	 * @param {string} options.eventType - Event type
	 * @param {object} options.payload - Event payload
	 * @param {mongoose.ClientSession} options.session - MongoDB session
	 * @param {string} [options.eventId] - Optional custom event ID
	 * @param {string} [options.correlationId] - Optional custom correlation ID
	 * @returns {Promise<object>} Created outbox event
	 */
	async createEvent({
		eventType,
		payload,
		session,
		eventId,
		correlationId,
		destination,
	}) {
		// Auto-generate IDs if not provided
		const finalEventId = eventId || uuid()
		const finalCorrelationId = correlationId || this._getCorrelationId()

		logger.debug(
			{
				eventType,
				eventId: finalEventId,
				correlationId: finalCorrelationId,
				serviceName: this.serviceName,
			},
			'📝 Creating outbox event'
		)

		const event = await createOutboxEvent(
			this.OutboxModel,
			eventType,
			payload,
			finalEventId,
			finalCorrelationId,
			session,
			destination
		)

		logger.debug(
			{
				eventType,
				eventId: finalEventId,
				serviceName: this.serviceName,
			},
			'✓ Outbox event created'
		)

		return event
	}

	/**
	 * Start the outbox processor
	 */
	async startProcessor() {
		if (this.processor) {
			logger.warn(
				{ serviceName: this.serviceName },
				'Processor already started'
			)
			return
		}

		this.processor = new OutboxProcessor(this.serviceName, this.connection)
		await this.processor.start()
	}

	/**
	 * Stop the outbox processor
	 */
	async stopProcessor() {
		if (this.processor) {
			await this.processor.stop()
			this.processor = null
		}
	}

	/**
	 * Get outbox statistics
	 */
	async getStats() {
		if (!this.processor) {
			throw new Error('Processor not started')
		}
		return await this.processor.getStats()
	}

	/**
	 * Retry failed events
	 */
	async retryFailed(limit = 10) {
		if (!this.processor) {
			throw new Error('Processor not started')
		}
		return await this.processor.retryFailed(limit)
	}

	/**
	 * Get correlation ID from OpenTelemetry context
	 * @private
	 */
	_getCorrelationId() {
		const span = trace.getSpan(context.active())
		return span?.spanContext().traceId || uuid()
	}

	/**
	 * Query outbox events
	 *
	 * @param {object} filter - MongoDB filter
	 * @param {object} options - Query options
	 * @returns {Promise<Array>} Outbox events
	 */
	async queryEvents(filter = {}, options = {}) {
		return await this.OutboxModel.find(filter, null, options).lean()
	}

	/**
	 * Get events by correlation ID (for tracing)
	 *
	 * @param {string} correlationId - Correlation ID
	 * @returns {Promise<Array>} Outbox events
	 */
	async getEventsByCorrelationId(correlationId) {
		return await this.OutboxModel.find({ correlationId })
			.sort({ createdAt: 1 })
			.lean()
	}

	/**
	 * Get pending events count
	 */
	async getPendingCount() {
		return await this.OutboxModel.countDocuments({ status: 'PENDING' })
	}

	/**
	 * Get failed events count
	 */
	async getFailedCount() {
		return await this.OutboxModel.countDocuments({ status: 'FAILED' })
	}

	/**
	 * Clean up old published events
	 *
	 * @param {number} daysOld - Days old threshold (default: 7)
	 * @returns {Promise<number>} Number of deleted events
	 */
	async cleanup(daysOld = 7) {
		const cutoffDate = new Date()
		cutoffDate.setDate(cutoffDate.getDate() - daysOld)

		const result = await this.OutboxModel.deleteMany({
			status: 'PUBLISHED',
			publishedAt: { $lt: cutoffDate },
		})

		logger.info(
			{
				deleted: result.deletedCount,
				daysOld,
				serviceName: this.serviceName,
			},
			'🗑️  Cleaned up old outbox events'
		)

		return result.deletedCount
	}
}

export default OutboxManager
