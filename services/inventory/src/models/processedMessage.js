const mongoose = require("mongoose");

const processedMessageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  queue: {
    type: String,
    required: true,
  },
  processedAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24 * 7, // expire after 7 days to avoid unbounded growth
  },
});

const ProcessedMessage = mongoose.model(
  "ProcessedMessage",
  processedMessageSchema
);

module.exports = ProcessedMessage;
