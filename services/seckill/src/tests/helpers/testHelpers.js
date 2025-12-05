/**
 * Shared test helpers for Seckill Service Property Tests
 */

const { createClient } = require('redis')
const fc = require('fast-check')
const fs = require('fs')
const path = require('path')

const REDIS_URL = process.env.REDIS_SECKILL_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379'

/**
 * Create and connect Redis client
 */
async function createRedisClient() {
  const client = createClient({ url: REDIS_URL })
  
  client.on('error', (err) => {
    console.error('Redis error:', err.message)
  })

  await client.connect()
  return client
}

/**
 * Helper to initialize a campaign directly in Redis
 */
async function initCampaign(client, productId, params) {
  const { stock, price, startTime, endTime } = params
  const keys = {
    stock: `seckill:test:${productId}:stock`,
    total: `seckill:test:${productId}:total`,
    price: `seckill:test:${productId}:price`,
    start: `seckill:test:${productId}:start`,
    end: `seckill:test:${productId}:end`,
    users: `seckill:test:${productId}:users`,
  }

  const multi = client.multi()
  multi.set(keys.stock, String(stock))
  multi.set(keys.total, String(stock))
  multi.set(keys.price, String(price))
  multi.set(keys.start, startTime)
  multi.set(keys.end, endTime)
  multi.del(keys.users)
  await multi.exec()

  return { success: true, productId, stock, price, startTime, endTime }
}

/**
 * Helper to get campaign status from Redis
 */
async function getStatus(client, productId) {
  const keys = {
    stock: `seckill:test:${productId}:stock`,
    total: `seckill:test:${productId}:total`,
    price: `seckill:test:${productId}:price`,
    start: `seckill:test:${productId}:start`,
    end: `seckill:test:${productId}:end`,
  }

  const [stock, total, price, startTime, endTime] = await Promise.all([
    client.get(keys.stock),
    client.get(keys.total),
    client.get(keys.price),
    client.get(keys.start),
    client.get(keys.end),
  ])

  if (stock === null || total === null) {
    return null
  }

  const now = new Date()
  const start = new Date(startTime)
  const end = new Date(endTime)
  const isActive = now >= start && now <= end

  return {
    productId,
    stockRemaining: parseInt(stock, 10),
    totalStock: parseInt(total, 10),
    price: parseFloat(price) || 0,
    isActive,
    startTime,
    endTime,
  }
}

/**
 * Helper to add users to winners set
 */
async function addWinners(client, productId, userIds) {
  const usersKey = `seckill:test:${productId}:users`
  if (userIds.length > 0) {
    await client.sAdd(usersKey, userIds)
  }
}

/**
 * Helper to get winners count
 */
async function getWinnersCount(client, productId) {
  const usersKey = `seckill:test:${productId}:users`
  return client.sCard(usersKey)
}

/**
 * Helper to check if user is in winners set
 */
async function isUserInWinners(client, productId, userId) {
  const usersKey = `seckill:test:${productId}:users`
  return client.sIsMember(usersKey, userId)
}

/**
 * Helper to clean up test keys
 */
async function cleanupTestKeys(client, productId) {
  await client.del(`seckill:test:${productId}:stock`)
  await client.del(`seckill:test:${productId}:total`)
  await client.del(`seckill:test:${productId}:price`)
  await client.del(`seckill:test:${productId}:start`)
  await client.del(`seckill:test:${productId}:end`)
  await client.del(`seckill:test:${productId}:users`)
}

/**
 * Load Lua scripts and return their SHA hashes
 */
async function loadLuaScripts(client) {
  const scriptsDir = path.join(__dirname, '../../scripts')
  
  const reserveScriptPath = path.join(scriptsDir, 'seckill-reserve.lua')
  const releaseScriptPath = path.join(scriptsDir, 'seckill-release.lua')
  
  const reserveScript = fs.readFileSync(reserveScriptPath, 'utf8')
  const releaseScript = fs.readFileSync(releaseScriptPath, 'utf8')
  
  const reserveSHA = await client.scriptLoad(reserveScript)
  const releaseSHA = await client.scriptLoad(releaseScript)
  
  return { reserveSHA, releaseSHA }
}

/**
 * Helper to execute the reserve script
 */
async function executeBuy(client, reserveSHA, productId, userId, rateLimit = 1000, rateWindow = 60) {
  const stockKey = `seckill:test:${productId}:stock`
  const usersKey = `seckill:test:${productId}:users`
  const rateLimitKey = `seckill:test:ratelimit:${userId}:${Math.floor(Date.now() / 1000 / rateWindow)}`

  return client.evalSha(reserveSHA, {
    keys: [stockKey, usersKey, rateLimitKey],
    arguments: [userId, String(rateLimit), String(rateWindow)]
  })
}

/**
 * Helper to execute the release script
 */
async function executeRelease(client, releaseSHA, productId, userId) {
  const stockKey = `seckill:test:${productId}:stock`
  const usersKey = `seckill:test:${productId}:users`

  return client.evalSha(releaseSHA, {
    keys: [stockKey, usersKey],
    arguments: [userId]
  })
}

/**
 * Generate unique product ID
 */
function generateProductId(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ============ Arbitraries (Generators) ============

/**
 * Generator for valid campaign parameters
 */
const validCampaignArb = fc.record({
  stock: fc.integer({ min: 1, max: 10000 }),
  priceCents: fc.integer({ min: 1, max: 9999999 }),
  startOffset: fc.integer({ min: -86400000, max: 86400000 }),
  duration: fc.integer({ min: 3600000, max: 604800000 }),
}).map(({ stock, priceCents, startOffset, duration }) => {
  const now = Date.now()
  const startTime = new Date(now + startOffset).toISOString()
  const endTime = new Date(now + startOffset + duration).toISOString()
  const price = priceCents / 100
  return { stock, price, startTime, endTime }
})

/**
 * Generator for active campaign parameters (startTime in past, endTime in future)
 */
const activeCampaignArb = fc.record({
  stock: fc.integer({ min: 1, max: 1000 }),
  priceCents: fc.integer({ min: 1, max: 9999999 }),
}).map(({ stock, priceCents }) => {
  const now = Date.now()
  const startTime = new Date(now - 3600000).toISOString()
  const endTime = new Date(now + 3600000).toISOString()
  const price = priceCents / 100
  return { stock, price, startTime, endTime }
})

/**
 * Generator for valid user IDs
 */
const userIdArb = fc.string({ minLength: 1, maxLength: 36 })
  .filter(s => s.trim().length > 0 && !s.includes(':'))
  .map(s => `user-${s}`)

/**
 * Generator for unique user IDs array (ensures no duplicates)
 */
const uniqueUserIdsArb = fc.array(
  fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => s.trim().length > 0 && !s.includes(':'))
    .map(s => `user-${s}`),
  { minLength: 1, maxLength: 50 }
).map(arr => [...new Set(arr)]) // Remove duplicates
  .filter(arr => arr.length > 0) // Ensure at least one user

module.exports = {
  REDIS_URL,
  createRedisClient,
  initCampaign,
  getStatus,
  addWinners,
  getWinnersCount,
  isUserInWinners,
  cleanupTestKeys,
  loadLuaScripts,
  executeBuy,
  executeRelease,
  generateProductId,
  // Arbitraries
  validCampaignArb,
  activeCampaignArb,
  userIdArb,
  uniqueUserIdsArb,
}
