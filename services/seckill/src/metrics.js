/**
 * Seckill Service - Business Metrics
 * 
 * Metrics specific to seckill/flash sale operations.
 * Uses @ecommerce/metrics shared package for common metrics.
 * 
 * Requirements: 7.1, 7.2, 7.3
 */

const { promClient } = require('@ecommerce/metrics')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECKILL REQUEST METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Total seckill requests counter
 * Labels:
 * - status: success, out_of_stock, already_purchased, rate_limited, campaign_not_started, error
 * - operation: buy, status, init, release
 * 
 * Requirements: 7.1
 */
const seckillRequestsTotal = new promClient.Counter({
  name: 'seckill_requests_total',
  help: 'Total number of seckill requests',
  labelNames: ['status', 'operation'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECKILL RESERVE LATENCY METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Seckill reserve operation latency histogram
 * Measures the duration of reserve operations (Lua script execution)
 * 
 * Buckets optimized for <50ms target latency
 * 
 * Requirements: 7.2
 */
const seckillReserveLatency = new promClient.Histogram({
  name: 'seckill_reserve_latency_seconds',
  help: 'Duration of seckill reserve operations in seconds',
  labelNames: ['status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECKILL STOCK METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Seckill stock remaining gauge
 * Tracks current remaining stock per productId
 * 
 * Requirements: 7.3
 */
const seckillStockRemaining = new promClient.Gauge({
  name: 'seckill_stock_remaining',
  help: 'Current remaining stock for seckill campaigns',
  labelNames: ['product_id'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GHOST ORDER TRACKING METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Seckill publish failures counter (Ghost Order tracking)
 * Tracks failed event publishes that require manual replay
 * 
 * Labels:
 * - event_type: seckill.order.won, seckill.released
 */
const seckillPublishFailuresTotal = new promClient.Counter({
  name: 'seckill_publish_failures_total',
  help: 'Total number of failed event publishes (Ghost Orders)',
  labelNames: ['event_type'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CAMPAIGN METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Seckill campaigns initialized counter
 */
const seckillCampaignsInitialized = new promClient.Counter({
  name: 'seckill_campaigns_initialized_total',
  help: 'Total number of seckill campaigns initialized',
  labelNames: ['product_id'],
})

/**
 * Seckill slots released counter
 */
const seckillSlotsReleased = new promClient.Counter({
  name: 'seckill_slots_released_total',
  help: 'Total number of seckill slots released (compensation)',
  labelNames: ['product_id'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Record a seckill request
 * @param {string} operation - Operation type (buy, status, init, release)
 * @param {string} status - Request status (success, out_of_stock, already_purchased, rate_limited, campaign_not_started, error)
 */
function recordSeckillRequest(operation, status) {
  seckillRequestsTotal.inc({ operation, status })
}

/**
 * Start a timer for reserve latency measurement
 * @returns {function} End timer function that takes status label
 */
function startReserveTimer() {
  return seckillReserveLatency.startTimer()
}

/**
 * Record reserve latency with status
 * @param {number} durationSeconds - Duration in seconds
 * @param {string} status - Operation status
 */
function recordReserveLatency(durationSeconds, status) {
  seckillReserveLatency.observe({ status }, durationSeconds)
}

/**
 * Update stock remaining gauge for a product
 * @param {string} productId - Product identifier
 * @param {number} stock - Current remaining stock
 */
function setStockRemaining(productId, stock) {
  seckillStockRemaining.set({ product_id: productId }, stock)
}

/**
 * Record a publish failure (Ghost Order)
 * @param {string} eventType - Event type that failed to publish
 */
function recordPublishFailure(eventType) {
  seckillPublishFailuresTotal.inc({ event_type: eventType })
}

/**
 * Record campaign initialization
 * @param {string} productId - Product identifier
 */
function recordCampaignInitialized(productId) {
  seckillCampaignsInitialized.inc({ product_id: productId })
}

/**
 * Record slot release
 * @param {string} productId - Product identifier
 */
function recordSlotReleased(productId) {
  seckillSlotsReleased.inc({ product_id: productId })
}

module.exports = {
  // Raw metrics
  seckillRequestsTotal,
  seckillReserveLatency,
  seckillStockRemaining,
  seckillPublishFailuresTotal,
  seckillCampaignsInitialized,
  seckillSlotsReleased,

  // Helper functions
  recordSeckillRequest,
  startReserveTimer,
  recordReserveLatency,
  setStockRemaining,
  recordPublishFailure,
  recordCampaignInitialized,
  recordSlotReleased,
}
