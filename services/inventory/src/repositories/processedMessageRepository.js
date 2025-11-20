const ProcessedMessage = require("../models/processedMessage");
const logger = require("@ecommerce/logger");

class ProcessedMessageRepository {
  async hasProcessed(messageId) {
    if (!messageId) {
      return false;
    }

    const existing = await ProcessedMessage.exists({ messageId });
    return Boolean(existing);
  }

  async markProcessed(messageId, queue) {
    if (!messageId) {
      return;
    }

    try {
      await ProcessedMessage.create({ messageId, queue });
    } catch (error) {
      if (error.code === 11000) {
        logger.warn(
          {
            messageId,
            queue,
          },
          "[Inventory] Duplicate processed message detected during markProcessed"
        );
        return;
      }

      logger.error(
        {
          messageId,
          queue,
          error: error.message,
        },
        "[Inventory] Failed to mark message as processed"
      );
      throw error;
    }
  }
}

module.exports = new ProcessedMessageRepository();
