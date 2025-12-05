const { v4: uuidv4 } = require('uuid')
const fs = require('fs')
const path = require('path')
const logger = require('@ecommerce/logger')
const redisClient = require('../config/redis')
const config = require('../config')
const { CampaignInitSchema } = require('../schemas/seckillEvents.schema')
const metrics = require('../metrics')
const tracing = require('../tracing')

// Emergency log file for Ghost Order fallback
const EMERGENCY_LOG_PATH = path.join(__dirname, '../../logs/emergency-events.log')

/**
 * Seckill Service - Core business logic for flash sale operations
 * 
 * Responsibilities:
 * - Campaign initialization and management
 * - Atomic purchase operations via Lua scripts
 * - Status retrieval
 * - Slot release for compensation
 */
class SeckillService {
  constructor() {
    this.messageBroker = null
  }

  /**
   * Set the message broker instance for event publishing
   * @param {Object} broker - Message broker instance
   */
  setMessageBroker(broker) {
    this.messageBroker = broker
  }

  /**
   * Initialize a seckill campaign
   * Stores campaign data in Redis and clears any existing winners
   * 
   * @param {Object} params - Campaign parameters
   * @param {string} params.productId - Product identifier
   * @param {number} params.stock - Initial stock count
   * @param {number} params.price - Product price
   * @param {string} params.startTime - Campaign start time (ISO string)
   * @param {string} params.endTime - Campaign end time (ISO string)
   * @returns {Promise<Object>} Campaign initialization result
   */
  async initCampaign(params) {
    // Validate input using Zod schema
    const validated = CampaignInitSchema.parse(params)
    const { productId, stock, price, startTime, endTime } = validated

    const keys = {
      stock: `seckill:${productId}:stock`,
      total: `seckill:${productId}:total`,
      price: `seckill:${productId}:price`,
      start: `seckill:${productId}:start`,
      end: `seckill:${productId}:end`,
      users: `seckill:${productId}:users`,
    }

    // Use Redis pipeline for atomic multi-key operations
    await redisClient.multi((multi) => {
      // Set campaign data
      multi.set(keys.stock, String(stock))
      multi.set(keys.total, String(stock))
      multi.set(keys.price, String(price))
      multi.set(keys.start, startTime)
      multi.set(keys.end, endTime)
      // Clear existing winners set (for re-initialization)
      multi.del(keys.users)
    })

    logger.info({ productId, stock, price, startTime, endTime }, 'Seckill campaign initialized')

    // Record metrics
    metrics.recordCampaignInitialized(productId)
    metrics.setStockRemaining(productId, stock)
    metrics.recordSeckillRequest('init', 'success')

    return {
      success: true,
      productId,
      stock,
      price,
      startTime,
      endTime,
    }
  }

  /**
   * Execute a purchase attempt
   * Uses Lua script for atomic stock check, duplicate check, and reservation
   * 
   * @param {string} userId - User identifier
   * @param {string} productId - Product identifier
   * @returns {Promise<Object>} Purchase result
   */
  async buy(userId, productId) {
    const stockKey = `seckill:${productId}:stock`
    const usersKey = `seckill:${productId}:users`
    const window = Math.floor(Date.now() / 1000 / config.rateWindow)
    const rateLimitKey = `seckill:ratelimit:${userId}:${window}`

    // Start latency timer
    const endTimer = metrics.startReserveTimer()

    // Execute atomic Lua script
    const result = await redisClient.evalSha('reserve', {
      keys: [stockKey, usersKey, rateLimitKey],
      arguments: [userId, String(config.rateLimit), String(config.rateWindow)],
    })

    // Handle Lua script return codes
    if (result === -4) {
      endTimer({ status: 'rate_limited' })
      metrics.recordSeckillRequest('buy', 'rate_limited')
      return { success: false, error: 'RATE_LIMIT_EXCEEDED' }
    }
    if (result === -2) {
      endTimer({ status: 'already_purchased' })
      metrics.recordSeckillRequest('buy', 'already_purchased')
      return { success: false, error: 'ALREADY_PURCHASED' }
    }
    if (result === -3) {
      endTimer({ status: 'campaign_not_started' })
      metrics.recordSeckillRequest('buy', 'campaign_not_started')
      return { success: false, error: 'CAMPAIGN_NOT_STARTED' }
    }
    if (result === -1) {
      endTimer({ status: 'out_of_stock' })
      metrics.recordSeckillRequest('buy', 'out_of_stock')
      return { success: false, error: 'OUT_OF_STOCK' }
    }

    // Record successful reserve latency
    endTimer({ status: 'success' })

    // Success - generate orderId and publish event
    const orderId = uuidv4()
    const eventId = uuidv4()
    // Use trace ID as correlationId for distributed tracing, fallback to UUID
    const correlationId = tracing.getCurrentTraceId() || uuidv4()

    // Get price for the event
    const price = await redisClient.get(`seckill:${productId}:price`)

    const eventData = {
      userId,
      productId,
      price: parseFloat(price) || 0,
      quantity: 1,
      timestamp: Date.now(),
      metadata: {
        source: 'seckill',
      },
    }

    // Publish event with Ghost Order fallback
    try {
      if (this.messageBroker) {
        await this.messageBroker.publish('seckill.order.won', eventData, {
          eventId,
          correlationId,
        })
        logger.info({ orderId, userId, productId, eventId }, 'seckill.order.won event published')
      }
    } catch (error) {
      // Ghost Order fallback: log to emergency file for manual replay
      logger.error({ error: error.message, orderId, userId, productId }, 'Failed to publish seckill.order.won event')
      this._logEmergencyEvent({ orderId, eventId, correlationId, eventData, error: error.message })
      // Record publish failure metric
      metrics.recordPublishFailure('seckill.order.won')
    }

    // Record successful buy request
    metrics.recordSeckillRequest('buy', 'success')

    // Update stock remaining metric (async, don't block response)
    this._updateStockMetric(productId)

    return {
      success: true,
      orderId,
      userId,
      productId,
    }
  }

  /**
   * Update stock remaining metric asynchronously
   * @private
   * @param {string} productId - Product identifier
   */
  async _updateStockMetric(productId) {
    try {
      const stock = await redisClient.get(`seckill:${productId}:stock`)
      if (stock !== null) {
        metrics.setStockRemaining(productId, parseInt(stock, 10))
      }
    } catch (error) {
      logger.warn({ error: error.message, productId }, 'Failed to update stock metric')
    }
  }


  /**
   * Get campaign status
   * 
   * @param {string} productId - Product identifier
   * @returns {Promise<Object|null>} Campaign status or null if not found
   */
  async getStatus(productId) {
    const keys = {
      stock: `seckill:${productId}:stock`,
      total: `seckill:${productId}:total`,
      price: `seckill:${productId}:price`,
      start: `seckill:${productId}:start`,
      end: `seckill:${productId}:end`,
    }

    const [stock, total, price, startTime, endTime] = await Promise.all([
      redisClient.get(keys.stock),
      redisClient.get(keys.total),
      redisClient.get(keys.price),
      redisClient.get(keys.start),
      redisClient.get(keys.end),
    ])

    // Campaign not found
    if (stock === null || total === null) {
      metrics.recordSeckillRequest('status', 'not_found')
      return null
    }

    const now = new Date()
    const start = new Date(startTime)
    const end = new Date(endTime)
    const isActive = now >= start && now <= end

    const stockRemaining = parseInt(stock, 10)

    // Update stock metric and record request
    metrics.setStockRemaining(productId, stockRemaining)
    metrics.recordSeckillRequest('status', 'success')

    return {
      productId,
      stockRemaining,
      totalStock: parseInt(total, 10),
      price: parseFloat(price) || 0,
      isActive,
      startTime,
      endTime,
    }
  }

  /**
   * Release a user's seckill slot (compensation)
   * Used when downstream operations fail (e.g., payment failure)
   * 
   * @param {string} userId - User identifier
   * @param {string} productId - Product identifier
   * @param {Object} options - Additional options
   * @param {string} options.orderId - Order identifier for event publishing
   * @returns {Promise<Object>} Release result
   */
  async releaseSlot(userId, productId, options = {}) {
    const { orderId } = options
    const stockKey = `seckill:${productId}:stock`
    const usersKey = `seckill:${productId}:users`

    // Execute atomic Lua script for release
    const result = await redisClient.evalSha('release', {
      keys: [stockKey, usersKey],
      arguments: [userId],
    })

    // Handle Lua script return codes
    if (result === -1) {
      // User not found - idempotent success
      logger.info({ userId, productId }, 'Slot release: user not found (already released or never purchased)')
      metrics.recordSeckillRequest('release', 'not_found')
      return { success: true, released: false, message: 'User not found in winners set' }
    }

    // Success - publish seckill.released event
    const eventId = uuidv4()
    // Use trace ID as correlationId for distributed tracing, fallback to UUID
    const correlationId = tracing.getCurrentTraceId() || uuidv4()

    const eventData = {
      orderId: orderId || 'unknown',
      userId,
      productId,
    }

    try {
      if (this.messageBroker) {
        await this.messageBroker.publish('seckill.released', eventData, {
          eventId,
          correlationId,
        })
        logger.info({ orderId, userId, productId, eventId }, 'seckill.released event published')
      }
    } catch (error) {
      logger.error({ error: error.message, orderId, userId, productId }, 'Failed to publish seckill.released event')
      this._logEmergencyEvent({ orderId, eventId, correlationId, eventData, error: error.message })
      // Record publish failure metric
      metrics.recordPublishFailure('seckill.released')
    }

    // Record metrics
    metrics.recordSlotReleased(productId)
    metrics.recordSeckillRequest('release', 'success')

    // Update stock remaining metric (async, don't block response)
    this._updateStockMetric(productId)

    logger.info({ userId, productId }, 'Seckill slot released successfully')
    return { success: true, released: true }
  }

  /**
   * Log emergency event to file for manual replay
   * Ghost Order fallback when message broker fails
   * 
   * @private
   * @param {Object} eventData - Event data to log
   */
  _logEmergencyEvent(eventData) {
    try {
      const logDir = path.dirname(EMERGENCY_LOG_PATH)
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
      }

      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...eventData,
      }) + '\n'

      fs.appendFileSync(EMERGENCY_LOG_PATH, logEntry)
      logger.warn({ path: EMERGENCY_LOG_PATH }, 'Emergency event logged to file')
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to log emergency event')
    }
  }
}

module.exports = new SeckillService()
