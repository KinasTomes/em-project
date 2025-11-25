const Outbox = require('../models/outbox');
const logger = require('@ecommerce/logger');

/**
 * Repository for Outbox operations
 * Handles CRUD operations for outbox events
 */
class OutboxRepository {
  /**
   * Create a new outbox event
   * @param {Object} eventData - Event data
   * @param {Object} session - MongoDB session for transaction
   */
  static async create(eventData, session = null) {
    try {
      const outbox = new Outbox(eventData);
      await outbox.save({ session });
      logger.info({ eventId: outbox._id, eventType: outbox.eventType }, 'Outbox event created');
      return outbox;
    } catch (error) {
      logger.error({ error: error.message }, 'Error creating outbox event');
      throw error;
    }
  }

  /**
   * Mark an outbox event as published
   * @param {String} outboxId - Outbox event ID
   * @param {Object} session - MongoDB session for transaction
   */
  static async markPublished(outboxId, session = null) {
    try {
      const outbox = await Outbox.findById(outboxId).session(session);
      if (!outbox) {
        throw new Error('Outbox event not found');
      }
      await outbox.markPublished();
      logger.info({ eventId: outboxId }, 'Outbox event marked as published');
      return outbox;
    } catch (error) {
      logger.error({ error: error.message, outboxId }, 'Error marking outbox as published');
      throw error;
    }
  }

  /**
   * Mark an outbox event as failed
   * @param {String} outboxId - Outbox event ID
   * @param {Error} error - Error object
   * @param {Object} session - MongoDB session for transaction
   */
  static async markFailed(outboxId, error, session = null) {
    try {
      const outbox = await Outbox.findById(outboxId).session(session);
      if (!outbox) {
        throw new Error('Outbox event not found');
      }
      await outbox.markFailed(error);
      logger.error({ eventId: outboxId, error: error.message }, 'Outbox event marked as failed');
      return outbox;
    } catch (err) {
      logger.error({ error: err.message, outboxId }, 'Error marking outbox as failed');
      throw err;
    }
  }

  /**
   * Find pending outbox events
   * @param {Number} limit - Maximum number of events to return
   */
  static async findPending(limit = 100) {
    try {
      const events = await Outbox.find({ status: 'PENDING' })
        .sort({ createdAt: 1 })
        .limit(limit);
      return events;
    } catch (error) {
      logger.error({ error: error.message }, 'Error finding pending outbox events');
      throw error;
    }
  }

  /**
   * Find retryable failed events
   * @param {Number} limit - Maximum number of events to return
   */
  static async findRetryable(limit = 50) {
    try {
      const events = await Outbox.find({
        status: 'FAILED',
        $expr: { $lt: ['$retryCount', '$maxRetries'] }
      })
        .sort({ createdAt: 1 })
        .limit(limit);
      return events;
    } catch (error) {
      logger.error({ error: error.message }, 'Error finding retryable outbox events');
      throw error;
    }
  }

  /**
   * Get outbox event by ID
   * @param {String} outboxId - Outbox event ID
   */
  static async findById(outboxId) {
    try {
      return await Outbox.findById(outboxId);
    } catch (error) {
      logger.error({ error: error.message, outboxId }, 'Error finding outbox by ID');
      throw error;
    }
  }

  /**
   * Get all events for an aggregate
   * @param {String} aggregateId - Aggregate ID
   */
  static async findByAggregateId(aggregateId) {
    try {
      return await Outbox.find({ aggregateId }).sort({ createdAt: -1 });
    } catch (error) {
      logger.error({ error: error.message, aggregateId }, 'Error finding outbox by aggregate ID');
      throw error;
    }
  }

  /**
   * Get statistics about outbox events
   */
  static async getStats() {
    try {
      const stats = await Outbox.aggregate([
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
        failed: 0
      };

      stats.forEach(stat => {
        result[stat._id.toLowerCase()] = stat.count;
      });

      return result;
    } catch (error) {
      logger.error({ error: error.message }, 'Error getting outbox stats');
      throw error;
    }
  }

  /**
   * Cleanup old events (backup to TTL index)
   * @param {Number} daysOld - Delete events older than this many days
   */
  static async cleanupOldEvents(daysOld = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const result = await Outbox.deleteMany({
        status: 'PUBLISHED',
        createdAt: { $lt: cutoffDate }
      });

      logger.info({ deletedCount: result.deletedCount, daysOld }, 'Old outbox events cleaned up');
      return result.deletedCount;
    } catch (error) {
      logger.error({ error: error.message }, 'Error cleaning up old outbox events');
      throw error;
    }
  }
}

module.exports = OutboxRepository;
