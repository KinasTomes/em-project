const express = require('express')
const { authMiddleware } = require('../middlewares/authMiddleware')
const seckillController = require('../controllers/seckillController')

const router = express.Router()

/**
 * Seckill Routes - Public API for flash sale operations
 * 
 * Routes:
 * - POST /buy - Purchase attempt (requires authentication)
 * - GET /status/:productId - Get campaign status (public)
 * 
 * Requirements: 2.1, 3.1
 */

// POST /seckill/buy - Purchase attempt
// Requires X-User-ID header (set by API Gateway after JWT verification)
router.post('/buy', authMiddleware, seckillController.buy)

// GET /seckill/status/:productId - Get campaign status
// Public endpoint - no authentication required
router.get('/status/:productId', seckillController.getStatus)

module.exports = router
