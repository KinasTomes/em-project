// packages/outbox-pattern/processors/OutboxProcessor.js

const logger = require('@ecommerce/logger');
const { Broker } = require('@ecommerce/message-broker');
const { createOutboxModel } = require('../models/OutboxModel.js');

/**
 * Outbox Processor - Watches outbox collection and publishes events to RabbitMQ
 * 
 * Uses MongoDB Change Streams to detect new PENDING events and publish them
 * to RabbitMQ using @ecommerce/message-broker.
 * 
 * Features:
 * - Real-time event detection (Change Streams)
 * - Automatic retry with exponential backoff
 * - DLQ handling after max retries
 * - Graceful shutdown
 * - Per-service isolation
 */
class OutboxProcessor {
  constructor(serviceName, connection) {
    this.serviceName = serviceName;
    this.connection = connection;
    this.broker = new Broker();
    this.changeStream = null;
    this.isRunning = false;
    this.resumeToken = null; // Resume token for recovery
    this.OutboxModel = createOutboxModel(serviceName, connection);

    logger.info({ serviceName }, 'OutboxProcessor initialized');
  }

  /**
   * Start watching outbox collection for new events
   */
  async start() {
    if (this.isRunning) {
      logger.warn({ serviceName: this.serviceName }, 'OutboxProcessor already running');
      return;
    }

    try {
      logger.info({ serviceName: this.serviceName }, '⏳ Starting Outbox Processor...');

      await this._startChangeStream();

      this.isRunning = true;
      logger.info({ serviceName: this.serviceName }, '✓ Outbox Processor started, watching for events');

    } catch (error) {
      logger.error({
        error: error.message,
        serviceName: this.serviceName
      }, '❌ Failed to start Outbox Processor');
      throw error;
    }
  }

  /**
   * Start Change Stream with resume token support
   * @private
   */
  async _startChangeStream(resumeAfter = null) {
    const options = {
      fullDocument: 'updateLookup'
    };

    // Resume from token if available (after restart/reconnect)
    if (resumeAfter) {
      options.resumeAfter = resumeAfter;
      logger.info({
        resumeAfter,
        serviceName: this.serviceName
      }, '🔄 Resuming change stream from token');
    }

    // Watch for new PENDING events in outbox collection
    this.changeStream = this.OutboxModel.watch([
      {
        $match: {
          operationType: 'insert',
          'fullDocument.status': 'PENDING'
        }
      }
    ], options);

    // Handle change events
    this.changeStream.on('change', async (change) => {
      // Save resume token immediately after receiving event
      this.resumeToken = change._id;

      const outboxEvent = change.fullDocument;
      await this.processEvent(outboxEvent);
    });

    // Handle errors with reconnection logic
    this.changeStream.on('error', async (error) => {
      logger.error({
        error: error.message,
        serviceName: this.serviceName,
        resumeToken: this.resumeToken
      }, '❌ Change stream error');

      // Close current stream
      try {
        if (this.changeStream) {
          await this.changeStream.close();
          this.changeStream = null;
        }
      } catch (closeError) {
        logger.warn({ error: closeError.message }, 'Error closing change stream');
      }

      // Attempt to reconnect after 5s delay
      if (this.isRunning) {
        logger.info({ serviceName: this.serviceName }, '⏳ Reconnecting in 5 seconds...');
        setTimeout(async () => {
          await this._reconnectChangeStream();
        }, 5000);
      }
    });

    // Handle stream close
    this.changeStream.on('close', () => {
      logger.warn({ serviceName: this.serviceName }, '⚠️  Change stream closed');
    });

    logger.info({ serviceName: this.serviceName }, '👀 Change stream watcher active');
  }

  /**
   * Reconnect Change Stream with resume token
   * @private
   */
  async _reconnectChangeStream() {
    try {
      logger.info({
        serviceName: this.serviceName,
        resumeToken: this.resumeToken
      }, '🔄 Attempting to reconnect change stream...');

      await this._startChangeStream(this.resumeToken);

      logger.info({ serviceName: this.serviceName }, '✓ Change stream reconnected successfully');

    } catch (error) {
      logger.error({
        error: error.message,
        serviceName: this.serviceName
      }, '❌ Failed to reconnect change stream');

      // Retry reconnection after 10s
      if (this.isRunning) {
        logger.info({ serviceName: this.serviceName }, '⏳ Retrying reconnection in 10 seconds...');
        setTimeout(async () => {
          await this._reconnectChangeStream();
        }, 10000);
      }
    }
  }

  /**
   * Process a single outbox event
   * 
   * @param {object} outboxEvent - Outbox event from Change Stream
   */
  async processEvent(outboxEvent) {
    const { _id, eventType, payload, eventId, correlationId, retries } = outboxEvent;

    const logContext = {
      eventType,
      eventId,
      correlationId,
      serviceName: this.serviceName,
      retries
    };

    try {
      logger.info(logContext, '📤 Processing outbox event');

      // Publish to RabbitMQ using MessageBroker
      await this.broker.publish(eventType, payload, {
        eventId,
        correlationId
      });

      logger.info(logContext, '✓ Event published to RabbitMQ');

      // Mark as PUBLISHED
      await this.OutboxModel.updateOne(
        { _id },
        {
          status: 'PUBLISHED',
          publishedAt: new Date()
        }
      );

      logger.info(logContext, '✓ Outbox event marked as PUBLISHED');

    } catch (error) {
      logger.error({
        ...logContext,
        error: error.message
      }, '❌ Failed to publish event');

      await this.handleRetry(outboxEvent, error);
    }
  }

  /**
   * Handle retry logic with exponential backoff
   * 
   * @param {object} outboxEvent - Outbox event
   * @param {Error} error - Error that occurred
   */
  async handleRetry(outboxEvent, error) {
    const { _id, eventId, retries } = outboxEvent;
    const maxRetries = 5;

    if (retries < maxRetries) {
      // Calculate next retry time with exponential backoff
      // 1s, 2s, 4s, 8s, 16s
      const nextRetryDelay = Math.pow(2, retries) * 1000;
      const nextRetry = new Date(Date.now() + nextRetryDelay);

      await this.OutboxModel.updateOne(
        { _id },
        {
          retries: retries + 1,
          nextRetry,
          error: error.message
        }
      );

      logger.warn({
        eventId,
        attempt: retries + 1,
        maxRetries,
        nextRetry: nextRetry.toISOString(),
        serviceName: this.serviceName
      }, `⏳ Scheduled retry ${retries + 1}/${maxRetries}`);

      // Schedule retry
      setTimeout(async () => {
        try {
          const event = await this.OutboxModel.findById(_id);
          if (event && event.status === 'PENDING') {
            await this.processEvent(event);
          }
        } catch (retryError) {
          logger.error({
            error: retryError.message,
            eventId
          }, '❌ Retry attempt failed');
        }
      }, nextRetryDelay);

    } else {
      // Max retries exceeded → Mark as FAILED (DLQ)
      await this.OutboxModel.updateOne(
        { _id },
        {
          status: 'FAILED',
          error: error.message
        }
      );

      logger.error({
        eventId,
        maxRetries,
        serviceName: this.serviceName,
        error: error.message
      }, `❌ Event failed after ${maxRetries} retries, marked as FAILED (DLQ)`);
    }
  }

  /**
   * Stop the Outbox Processor
   */
  async stop() {
    logger.info({ serviceName: this.serviceName }, '⏹️  Stopping Outbox Processor...');

    if (this.changeStream) {
      await this.changeStream.close();
      this.changeStream = null;
    }

    await this.broker.close();
    this.isRunning = false;

    logger.info({ serviceName: this.serviceName }, '✓ Outbox Processor stopped');
  }

  /**
   * Get statistics about outbox events
   * 
   * @returns {Promise<object>} Outbox statistics
   */
  async getStats() {
    const stats = await this.OutboxModel.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const result = {
      pending: 0,
      published: 0,
      failed: 0,
      total: 0,
      isRunning: this.isRunning,
      hasResumeToken: !!this.resumeToken
    };

    stats.forEach(stat => {
      const status = stat._id.toLowerCase();
      result[status] = stat.count;
      result.total += stat.count;
    });

    return result;
  }

  /**
   * Retry failed events manually
   * 
   * @param {number} limit - Max number of events to retry
   * @returns {Promise<number>} Number of events retried
   */
  async retryFailed(limit = 10) {
    const failedEvents = await this.OutboxModel.find({ status: 'FAILED' })
      .limit(limit)
      .lean();

    logger.info({
      count: failedEvents.length,
      serviceName: this.serviceName
    }, '🔄 Retrying failed events');

    let retriedCount = 0;

    for (const event of failedEvents) {
      try {
        // Reset event to PENDING
        await this.OutboxModel.updateOne(
          { _id: event._id },
          {
            status: 'PENDING',
            retries: 0,
            nextRetry: null,
            error: null
          }
        );

        // Process immediately
        await this.processEvent(event);
        retriedCount++;

      } catch (error) {
        logger.error({
          error: error.message,
          eventId: event.eventId
        }, '❌ Failed to retry event');
      }
    }

    logger.info({
      retriedCount,
      serviceName: this.serviceName
    }, '✓ Retry completed');

    return retriedCount;
  }
}

/**
 * Factory function to create and start Outbox Processor
 * 
 * @param {string} serviceName - Service name (e.g., 'order', 'inventory')
 * @param {mongoose.Connection} connection - Mongoose connection (optional)
 * @returns {Promise<OutboxProcessor>} Started processor instance
 * 
 * @example
 * import { startOutboxProcessor } from '@ecommerce/outbox-pattern';
 * 
 * const processor = await startOutboxProcessor('order');
 * 
 * // Later, to stop:
 * await processor.stop();
 */
async function startOutboxProcessor(serviceName, connection) {
  const processor = new OutboxProcessor(serviceName, connection);
  await processor.start();
  return processor;
}

module.exports = {
  OutboxProcessor,
  startOutboxProcessor,
  OutboxProcessorClass: OutboxProcessor
};
