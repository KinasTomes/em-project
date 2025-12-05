const logger = require('@ecommerce/logger')
const seckillService = require('../services/seckillService')
const { ReleaseEventSchema } = require('../schemas/seckillEvents.schema')

/**
 * Release Consumer - Handles compensation events from Order Service
 * 
 * Subscribes to `order.seckill.release` routing key to handle slot releases
 * when downstream operations fail (e.g., payment failure).
 * 
 * Requirements: 5.1, 5.2, 5.3, 6.3
 */

/**
 * Handle order.seckill.release event
 * 
 * Executes the release Lua script to atomically:
 * 1. Remove userId from winners set
 * 2. Increment stock
 * 3. Publish seckill.released confirmation event
 * 
 * The operation is idempotent - releasing a non-existent slot succeeds without error.
 * 
 * @param {Object} message - Release event data
 * @param {string} message.orderId - Order identifier
 * @param {string} message.userId - User identifier
 * @param {string} message.productId - Product identifier
 * @param {string} [message.reason] - Reason for release
 * @param {Object} metadata - Event metadata
 * @param {string} [metadata.eventId] - Event identifier
 * @param {string} [metadata.correlationId] - Correlation identifier
 */
async function handleSeckillRelease(message, metadata = {}) {
  const { eventId, correlationId } = metadata

  logger.info(
    { message, eventId, correlationId },
    '🔓 [Seckill] Handling order.seckill.release event'
  )

  // Validate message schema
  let validated
  try {
    validated = ReleaseEventSchema.parse(message)
  } catch (error) {
    logger.error(
      { error: error.message, message },
      '❌ [Seckill] Release event schema validation failed'
    )
    throw error
  }

  const { orderId, userId, productId, reason } = validated


  try {
    // Execute release via service
    const result = await seckillService.releaseSlot(userId, productId, { orderId })

    if (result.released) {
      logger.info(
        { orderId, userId, productId, reason, eventId, correlationId },
        '✓ [Seckill] Slot released successfully - seckill.released event published'
      )
    } else {
      logger.info(
        { orderId, userId, productId, reason, eventId, correlationId },
        '⚠️ [Seckill] Slot release: user not found (already released or never purchased) - idempotent success'
      )
    }
  } catch (error) {
    logger.error(
      { error: error.message, orderId, userId, productId, eventId, correlationId },
      '❌ [Seckill] Error processing release event'
    )
    throw error // Will be sent to DLQ by broker
  }
}

/**
 * Register release consumer with message broker
 * 
 * @param {Object} broker - Message broker instance
 */
async function registerReleaseConsumer(broker) {
  const queueName = 'q.seckill-release'
  const routingKeys = ['order.seckill.release']

  await broker.consume(
    queueName,
    async (rawMessage, metadata) => {
      await handleSeckillRelease(rawMessage, metadata)
    },
    null,
    routingKeys
  )

  logger.info(
    { queue: queueName, routingKeys },
    '✓ [Seckill] Release consumer ready (Event-Driven: order.seckill.release)'
  )
}

module.exports = {
  registerReleaseConsumer,
  handleSeckillRelease,
}
