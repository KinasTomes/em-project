const logger = require('@ecommerce/logger')
const seckillService = require('../services/seckillService')
const { CampaignInitSchema, ReleaseEventSchema } = require('../schemas/seckillEvents.schema')
const { ZodError } = require('zod')

/**
 * Admin Controller - HTTP request handlers for seckill administration
 * 
 * Handles:
 * - POST /admin/seckill/init - Initialize a seckill campaign
 * - POST /admin/seckill/release - Manually release a user's slot
 * 
 * Requirements: 1.1, 1.4, 5.1
 */
class AdminController {
  constructor() {
    this.initCampaign = this.initCampaign.bind(this)
    this.releaseSlot = this.releaseSlot.bind(this)
  }

  /**
   * POST /admin/seckill/init
   * Initialize a seckill campaign with product details
   * 
   * Admin key validation is handled by adminAuthMiddleware
   * 
   * Request body:
   * - productId: string - Product identifier
   * - stock: number - Initial stock count
   * - price: number - Product price
   * - startTime: string - Campaign start time (ISO string)
   * - endTime: string - Campaign end time (ISO string)
   * 
   * Returns:
   * - 200 OK: Campaign initialized successfully
   * - 400 Bad Request: Validation error
   * - 401 Unauthorized: Invalid admin key (handled by middleware)
   * 
   * Requirements: 1.1, 1.4
   */
  async initCampaign(req, res) {
    try {
      // Validate request body
      let validated
      try {
        validated = CampaignInitSchema.parse(req.body)
      } catch (error) {
        if (error instanceof ZodError) {
          logger.warn({ errors: error.errors }, 'Campaign init validation failed')
          return res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Invalid campaign parameters',
            details: error.errors,
          })
        }
        throw error
      }


      // Initialize campaign via service
      const result = await seckillService.initCampaign(validated)

      logger.info(
        { productId: validated.productId, stock: validated.stock },
        'Campaign initialized by admin'
      )

      return res.status(200).json({
        success: true,
        message: 'Campaign initialized successfully',
        campaign: result,
      })
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, 'Admin initCampaign handler error')
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      })
    }
  }

  /**
   * POST /admin/seckill/release
   * Manually release a user's seckill slot (compensation)
   * 
   * Admin key validation is handled by adminAuthMiddleware
   * 
   * Request body:
   * - orderId: string - Order identifier
   * - userId: string - User identifier
   * - productId: string - Product identifier
   * - reason: string (optional) - Reason for release
   * 
   * Returns:
   * - 200 OK: Slot released successfully
   * - 400 Bad Request: Validation error
   * - 401 Unauthorized: Invalid admin key (handled by middleware)
   * 
   * Requirements: 5.1
   */
  async releaseSlot(req, res) {
    try {
      // Validate request body
      let validated
      try {
        validated = ReleaseEventSchema.parse(req.body)
      } catch (error) {
        if (error instanceof ZodError) {
          logger.warn({ errors: error.errors }, 'Release slot validation failed')
          return res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Invalid release parameters',
            details: error.errors,
          })
        }
        throw error
      }

      const { orderId, userId, productId, reason } = validated

      // Release slot via service
      const result = await seckillService.releaseSlot(userId, productId, { orderId })

      logger.info(
        { orderId, userId, productId, reason, released: result.released },
        'Slot release requested by admin'
      )

      return res.status(200).json({
        success: true,
        released: result.released,
        message: result.released
          ? 'Slot released successfully'
          : 'User not found in winners set (already released or never purchased)',
      })
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, 'Admin releaseSlot handler error')
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      })
    }
  }
}

module.exports = new AdminController()
