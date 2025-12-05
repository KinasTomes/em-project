const express = require('express')
const { adminAuthMiddleware } = require('../middlewares/adminAuthMiddleware')
const adminController = require('../controllers/adminController')

const router = express.Router()

/**
 * Admin Routes - Administrative API for seckill campaign management
 * 
 * All routes require X-Admin-Key header for authentication.
 * 
 * Routes:
 * - POST /admin/seckill/init - Initialize a seckill campaign
 * - POST /admin/seckill/release - Manually release a user's slot
 * 
 * Requirements: 1.1, 5.1
 */

// POST /admin/seckill/init - Initialize a seckill campaign
// Requires X-Admin-Key header
router.post('/init', adminAuthMiddleware, adminController.initCampaign)

// POST /admin/seckill/release - Manually release a user's slot (compensation)
// Requires X-Admin-Key header
router.post('/release', adminAuthMiddleware, adminController.releaseSlot)

module.exports = router
