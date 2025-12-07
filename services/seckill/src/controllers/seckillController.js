const logger = require('@ecommerce/logger')
const seckillService = require('../services/seckillService')
const { BuyRequestSchema } = require('../schemas/seckillEvents.schema')
const { ZodError } = require('zod')

/**
 * Seckill Controller - HTTP request handlers for flash sale operations
 * 
 * Handles:
 * - POST /seckill/buy - Purchase attempt
 * - GET /seckill/status/:productId - Campaign status
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 3.1, 3.2
 */
class SeckillController {
  constructor() {
    this.buy = this.buy.bind(this)
    this.getStatus = this.getStatus.bind(this)
  }

  /**
   * POST /seckill/buy
   * Handle purchase request for a seckill campaign
   * 
   * Extracts userId from X-User-ID header (set by API Gateway after JWT verification)
   * Returns appropriate error codes based on Lua script results:
   * - 202 Accepted: Purchase successful
   * - 400 Bad Request: Validation error or campaign not started
   * - 401 Unauthorized: Missing/invalid authentication
   * - 409 Conflict: Out of stock or already purchased
   * - 429 Too Many Requests: Rate limit exceeded
   * 
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.6
   */
  async buy(req, res) {
    try {
      // Extract userId from X-User-ID header (set by API Gateway after JWT verification)
      // This avoids CPU-intensive JWT verification in the hot path
      const userId = req.headers['x-user-id'] || req.user?.id
      if (!userId) {
        logger.warn({ headers: Object.keys(req.headers) }, 'Buy request missing X-User-ID header')
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'User authentication required',
        })
      }

      // Validate request body
      let validated
      try {
        validated = BuyRequestSchema.parse(req.body)
      } catch (error) {
        if (error instanceof ZodError) {
          logger.warn({ errors: error.errors }, 'Buy request validation failed')
          return res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          })
        }
        throw error
      }

      const { productId } = validated

      // Execute purchase via service
      const result = await seckillService.buy(userId, productId)

      // Handle error responses based on Lua script return codes
      if (!result.success) {
        const errorResponses = {
          OUT_OF_STOCK: {
            status: 409,
            body: {
              error: 'OUT_OF_STOCK',
              message: 'Product is out of stock',
            },
          },
          ALREADY_PURCHASED: {
            status: 409,
            body: {
              error: 'ALREADY_PURCHASED',
              message: 'You have already purchased this product',
            },
          },
          CAMPAIGN_NOT_STARTED: {
            status: 400,
            body: {
              error: 'CAMPAIGN_NOT_STARTED',
              message: 'Campaign has not started or does not exist',
            },
          },
          RATE_LIMIT_EXCEEDED: {
            status: 429,
            body: {
              error: 'RATE_LIMIT_EXCEEDED',
              message: 'Too many requests. Please try again later.',
            },
          },
        }

        const errorResponse = errorResponses[result.error]
        if (errorResponse) {
          logger.info({ userId, productId, error: result.error }, 'Seckill purchase rejected')
          return res.status(errorResponse.status).json(errorResponse.body)
        }

        // Unknown error
        logger.error({ userId, productId, error: result.error }, 'Unknown seckill error')
        return res.status(500).json({
          error: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        })
      }

      // Success - return 202 Accepted with correlationId for tracking
      logger.info({ userId, productId, correlationId: result.correlationId }, 'Seckill purchase successful')
      return res.status(202).json({
        success: true,
        correlationId: result.correlationId,
        message: 'Purchase accepted. Order is being processed. Use correlationId to track order status.',
      })
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, 'Seckill buy handler error')
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      })
    }
  }

  /**
   * GET /seckill/status/:productId
   * Get campaign status including remaining stock and timing
   * 
   * Returns:
   * - 200 OK: Campaign status
   * - 404 Not Found: Campaign does not exist
   * 
   * Requirements: 3.1, 3.2
   */
  async getStatus(req, res) {
    try {
      const { productId } = req.params

      if (!productId) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'productId is required',
        })
      }

      const status = await seckillService.getStatus(productId)

      if (!status) {
        logger.info({ productId }, 'Campaign not found')
        return res.status(404).json({
          error: 'CAMPAIGN_NOT_FOUND',
          message: 'Campaign does not exist',
        })
      }

      return res.status(200).json(status)
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, 'Seckill getStatus handler error')
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      })
    }
  }
}

module.exports = new SeckillController()
