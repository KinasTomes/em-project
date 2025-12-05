const logger = require('@ecommerce/logger')

/**
 * Authentication Middleware for Seckill Service
 * 
 * Extracts X-User-ID header set by API Gateway after JWT verification.
 * No JWT verification is performed here - the API Gateway handles that.
 * This keeps the hot path fast by avoiding CPU-intensive JWT operations.
 * 
 * Requirements: 2.5
 */

/**
 * Middleware to extract and validate X-User-ID header
 * 
 * The API Gateway verifies the JWT token and sets the X-User-ID header
 * with the authenticated user's ID. This middleware simply extracts
 * that header and attaches it to the request object.
 * 
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 */
function authMiddleware(req, res, next) {
  const userId = req.headers['x-user-id']

  if (!userId) {
    logger.warn(
      { path: req.path, method: req.method },
      'Request missing X-User-ID header'
    )
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'User authentication required',
    })
  }

  // Attach userId to request for downstream handlers
  req.user = { id: userId }

  next()
}

module.exports = { authMiddleware }
