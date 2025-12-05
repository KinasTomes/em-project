const logger = require('@ecommerce/logger')
const config = require('../config')

/**
 * Admin Authentication Middleware for Seckill Service
 * 
 * Verifies the X-Admin-Key header against the configured admin key.
 * Returns 401 Unauthorized for invalid or missing admin keys.
 * 
 * Requirements: 1.4
 */

/**
 * Middleware to verify X-Admin-Key header
 * 
 * The admin key is configured via SECKILL_ADMIN_KEY environment variable.
 * This middleware validates that the provided key matches the configured key.
 * 
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 */
function adminAuthMiddleware(req, res, next) {
  const adminKey = req.headers['x-admin-key']

  if (!adminKey) {
    logger.warn(
      { path: req.path, method: req.method },
      'Admin request missing X-Admin-Key header'
    )
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Admin authentication required',
    })
  }

  // Validate admin key against configured value
  if (adminKey !== config.adminKey) {
    logger.warn(
      { path: req.path, method: req.method },
      'Admin request with invalid X-Admin-Key'
    )
    return res.status(401).json({
      error: 'INVALID_ADMIN_KEY',
      message: 'Invalid admin key provided',
    })
  }

  // Admin key is valid, proceed to handler
  logger.debug({ path: req.path }, 'Admin authentication successful')
  next()
}

module.exports = { adminAuthMiddleware }
