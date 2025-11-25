const mongoose = require('mongoose');

/**
 * Outbox Pattern Model for Inventory Service
 * Ensures atomic publishing of events alongside database updates
 */
const outboxSchema = new mongoose.Schema({
  // Event identification
  eventType: {
    type: String,
    required: true,
    enum: [
      'INVENTORY_RESERVED',
      'INVENTORY_RESERVE_FAILED',
      'INVENTORY_RELEASED',
      'STOCK_UPDATED',
      'INVENTORY_RESTOCKED'
    ]
  },
  
  // Aggregate information
  aggregateId: {
    type: String,
    required: true,
    index: true
  },
  
  aggregateType: {
    type: String,
    required: true,
    enum: ['Order', 'Product']
  },
  
  // Event payload
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  
  // Metadata for tracking and debugging
  metadata: {
    service: { type: String, default: 'inventory' },
    operation: String,
    correlationId: String,
    causationId: String,
    userId: String,
    timestamp: { type: Date, default: Date.now }
  },
  
  // Processing status
  status: {
    type: String,
    required: true,
    enum: ['PENDING', 'PUBLISHED', 'FAILED'],
    default: 'PENDING',
    index: true
  },
  
  // Retry mechanism
  retryCount: {
    type: Number,
    default: 0
  },
  
  maxRetries: {
    type: Number,
    default: 3
  },
  
  // Error tracking
  lastError: {
    message: String,
    stack: String,
    timestamp: Date
  },
  
  // Publishing information
  publishedAt: Date,
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for efficient queries
outboxSchema.index({ status: 1, createdAt: 1 });
outboxSchema.index({ status: 1, retryCount: 1 });
outboxSchema.index({ aggregateId: 1, createdAt: -1 });

// TTL index - auto-delete published events after 7 days
outboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

// Update updatedAt on save
outboxSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Static method to create an outbox event
 */
outboxSchema.statics.createEvent = function(eventData) {
  return new this(eventData);
};

/**
 * Instance method to mark event as published
 */
outboxSchema.methods.markPublished = function() {
  this.status = 'PUBLISHED';
  this.publishedAt = new Date();
  return this.save();
};

/**
 * Instance method to mark event as failed
 */
outboxSchema.methods.markFailed = function(error) {
  this.status = 'FAILED';
  this.lastError = {
    message: error.message,
    stack: error.stack,
    timestamp: new Date()
  };
  return this.save();
};

/**
 * Instance method to increment retry count
 */
outboxSchema.methods.retry = function() {
  this.retryCount += 1;
  this.status = 'PENDING';
  return this.save();
};

const Outbox = mongoose.model('Outbox', outboxSchema);

module.exports = Outbox;
