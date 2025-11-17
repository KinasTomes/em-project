// packages/outbox-pattern/index.js

/**
 * @ecommerce/outbox-pattern
 * 
 * Transactional Outbox Pattern implementation for microservices.
 * 
 * Provides:
 * - Shared Outbox model (Mongoose schema)
 * - Outbox Processor (Change Streams watcher)
 * - Helper functions for event creation
 * - At-least-once delivery guarantee
 * 
 * @example
 * // Create outbox model
 * import { createOutboxModel, createOutboxEvent } from '@ecommerce/outbox-pattern';
 * 
 * const OrderOutbox = createOutboxModel('order');
 * 
 * // Use in transaction
 * const session = await mongoose.startSession();
 * session.startTransaction();
 * 
 * try {
 *   await Order.create([{ ... }], { session });
 *   await createOutboxEvent(
 *     OrderOutbox,
 *     'ORDER_CREATED',
 *     { orderId: '123' },
 *     eventId,
 *     correlationId,
 *     session
 *   );
 *   await session.commitTransaction();
 * } catch (error) {
 *   await session.abortTransaction();
 *   throw error;
 * } finally {
 *   session.endSession();
 * }
 * 
 * @example
 * // Start outbox processor
 * import { startOutboxProcessor } from '@ecommerce/outbox-pattern';
 * 
 * const processor = await startOutboxProcessor('order');
 * 
 * // Graceful shutdown
 * process.on('SIGTERM', async () => {
 *   await processor.stop();
 *   process.exit(0);
 * });
 */

// Export models
const {
  createOutboxModel,
  createOutboxEvent,
  outboxSchema
} = require('./models/OutboxModel.js');

// Export processors
const {
  OutboxProcessor,
  startOutboxProcessor,
  OutboxProcessorClass
} = require('./processors/OutboxProcessor.js');

// Export convenience wrapper
const { OutboxManager } = require('./OutboxManager.js');

module.exports = {
  createOutboxModel,
  createOutboxEvent,
  outboxSchema,
  OutboxProcessor,
  startOutboxProcessor,
  OutboxProcessorClass,
  OutboxManager
};
