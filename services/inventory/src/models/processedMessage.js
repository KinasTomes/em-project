const mongoose = require("mongoose");

/**
 * ProcessedMessage Schema - Tracks processed messages for idempotency
 * 
 * Uses TTL index to automatically clean up old records after 7 days.
 * This prevents the collection from growing indefinitely while maintaining
 * idempotency guarantees for duplicate messages within the retention window.
 */
const processedMessageSchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      description: "Unique message ID from RabbitMQ or event payload",
    },
    queue: {
      type: String,
      required: true,
      index: true,
      description: "Queue name where message was received",
    },
    processedAt: {
      type: Date,
      default: Date.now,
      required: true,
      expires: 604800, // TTL: 7 days in seconds (7 * 24 * 60 * 60)
      description: "Timestamp when message was first processed",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      description: "Optional metadata about the message",
    },
  },
  {
    timestamps: false, // processedAt serves as the timestamp
    collection: "processed_messages",
  }
);

// Compound index for efficient lookups by messageId + queue
processedMessageSchema.index({ messageId: 1, queue: 1 }, { unique: true });

// TTL index on processedAt (MongoDB will auto-delete after 7 days)
processedMessageSchema.index({ processedAt: 1 }, { expireAfterSeconds: 604800 });

const ProcessedMessage = mongoose.model("ProcessedMessage", processedMessageSchema);

module.exports = ProcessedMessage;
