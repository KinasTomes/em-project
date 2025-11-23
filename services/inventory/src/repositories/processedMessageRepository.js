const ProcessedMessage = require("../models/processedMessage");
const logger = require("@ecommerce/logger");

/**
 * Repository for managing processed messages (idempotency tracking)
 */
class ProcessedMessageRepository {
  /**
   * Check if a message has been processed
   * @param {string} messageId - Unique message ID
   * @returns {Promise<boolean>} True if already processed
   */
  async hasProcessed(messageId) {
    try {
      const existing = await ProcessedMessage.findOne({ messageId }).lean();
      return !!existing;
    } catch (error) {
      logger.error(
        {
          messageId,
          error: error.message,
        },
        "[ProcessedMessageRepository] Error checking if message processed"
      );
      throw error;
    }
  }

  /**
   * Mark a message as processed
   * @param {string} messageId - Unique message ID
   * @param {string} queue - Queue name
   * @param {object} metadata - Optional metadata to store
   * @returns {Promise<object>} Created document
   */
  async markProcessed(messageId, queue, metadata = {}) {
    try {
      const doc = await ProcessedMessage.create({
        messageId,
        queue,
        processedAt: new Date(),
        metadata,
      });

      logger.debug(
        {
          messageId,
          queue,
        },
        "[ProcessedMessageRepository] Message marked as processed"
      );

      return doc;
    } catch (error) {
      // Ignore duplicate key errors (race condition - message processed concurrently)
      if (error.code === 11000) {
        logger.warn(
          {
            messageId,
            queue,
          },
          "[ProcessedMessageRepository] Message already marked as processed (race condition)"
        );
        return null;
      }

      logger.error(
        {
          messageId,
          queue,
          error: error.message,
        },
        "[ProcessedMessageRepository] Error marking message as processed"
      );
      throw error;
    }
  }

  /**
   * Get processed message count (for monitoring)
   * @returns {Promise<number>} Count of processed messages
   */
  async getCount() {
    try {
      return await ProcessedMessage.countDocuments();
    } catch (error) {
      logger.error(
        {
          error: error.message,
        },
        "[ProcessedMessageRepository] Error getting count"
      );
      throw error;
    }
  }

  /**
   * Clean up old processed messages (manual, MongoDB TTL index does this automatically)
   * @param {number} daysOld - Delete records older than this many days
   * @returns {Promise<number>} Number of deleted records
   */
  async cleanup(daysOld = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const result = await ProcessedMessage.deleteMany({
        processedAt: { $lt: cutoffDate },
      });

      logger.info(
        {
          deleted: result.deletedCount,
          daysOld,
        },
        "[ProcessedMessageRepository] Cleaned up old processed messages"
      );

      return result.deletedCount;
    } catch (error) {
      logger.error(
        {
          error: error.message,
          daysOld,
        },
        "[ProcessedMessageRepository] Error during cleanup"
      );
      throw error;
    }
  }
}

module.exports = new ProcessedMessageRepository();
