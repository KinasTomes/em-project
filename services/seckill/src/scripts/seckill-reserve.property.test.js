/**
 * Property-Based Test for Seckill Reserve Lua Script
 * 
 * **Feature: seckill-service, Property 6: No Overselling Under Concurrency**
 * 
 * *For any* campaign with initial stock N and M concurrent purchase requests 
 * where M > N, the total number of successful purchases SHALL be exactly N 
 * (no more, no less), and the final stock SHALL be 0.
 * 
 * **Validates: Requirements 4.1**
 */

const { describe, it, before, after, beforeEach } = require('mocha')
const { expect } = require('chai')
const fc = require('fast-check')
const { createClient } = require('redis')
const fs = require('fs')
const path = require('path')

describe('Property 6: No Overselling Under Concurrency', function () {
  this.timeout(60000)

  let client
  let reserveScriptSHA
  const REDIS_URL = process.env.REDIS_SECKILL_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379'

  before(async function () {
    // Connect to Redis
    client = createClient({ url: REDIS_URL })
    
    client.on('error', (err) => {
      console.error('Redis error:', err.message)
    })

    try {
      await client.connect()
    } catch (err) {
      console.log('Redis not available, skipping tests')
      this.skip()
    }

    // Load the reserve Lua script
    const scriptPath = path.join(__dirname, 'seckill-reserve.lua')
    const script = fs.readFileSync(scriptPath, 'utf8')
    reserveScriptSHA = await client.scriptLoad(script)
  })

  after(async function () {
    if (client && client.isOpen) {
      await client.quit()
    }
  })

  beforeEach(async function () {
    // Clean up any test keys before each test
    const keys = await client.keys('seckill:test:*')
    if (keys.length > 0) {
      await client.del(keys)
    }
  })

  /**
   * Helper to execute the reserve script
   */
  async function executeReserve(productId, userId, rateLimit = 1000, rateWindow = 60) {
    const stockKey = `seckill:test:${productId}:stock`
    const usersKey = `seckill:test:${productId}:users`
    const rateLimitKey = `seckill:test:ratelimit:${userId}:${Math.floor(Date.now() / 1000 / rateWindow)}`

    return client.evalSha(reserveScriptSHA, {
      keys: [stockKey, usersKey, rateLimitKey],
      arguments: [userId, String(rateLimit), String(rateWindow)]
    })
  }

  /**
   * Helper to initialize a campaign
   */
  async function initCampaign(productId, stock) {
    const stockKey = `seckill:test:${productId}:stock`
    await client.set(stockKey, String(stock))
  }

  /**
   * Helper to get current stock
   */
  async function getStock(productId) {
    const stockKey = `seckill:test:${productId}:stock`
    const stock = await client.get(stockKey)
    return stock ? parseInt(stock, 10) : null
  }

  /**
   * Helper to get winners count
   */
  async function getWinnersCount(productId) {
    const usersKey = `seckill:test:${productId}:users`
    return client.sCard(usersKey)
  }

  // **Feature: seckill-service, Property 6: No Overselling Under Concurrency**
  it('should allow exactly N successful purchases for stock N with M > N concurrent requests', async function () {
    await fc.assert(
      fc.asyncProperty(
        // Generate stock between 1 and 50
        fc.integer({ min: 1, max: 50 }),
        // Generate number of concurrent requests (always more than stock)
        fc.integer({ min: 10, max: 100 }),
        async (stock, extraRequests) => {
          const totalRequests = stock + extraRequests
          const productId = `product-${Date.now()}-${Math.random().toString(36).slice(2)}`

          // Initialize campaign with stock N
          await initCampaign(productId, stock)

          // Generate unique user IDs for each request
          const userIds = Array.from({ length: totalRequests }, (_, i) => `user-${i}`)

          // Execute all requests concurrently
          const results = await Promise.all(
            userIds.map(userId => executeReserve(productId, userId))
          )

          // Count successful purchases (result === 1)
          const successCount = results.filter(r => r === 1).length
          
          // Count out of stock responses (result === -1)
          const outOfStockCount = results.filter(r => r === -1).length

          // Get final state
          const finalStock = await getStock(productId)
          const winnersCount = await getWinnersCount(productId)

          // Property assertions:
          // 1. Exactly N purchases should succeed
          expect(successCount).to.equal(stock, 
            `Expected exactly ${stock} successful purchases, got ${successCount}`)

          // 2. Final stock should be 0
          expect(finalStock).to.equal(0, 
            `Expected final stock to be 0, got ${finalStock}`)

          // 3. Winners count should equal successful purchases
          expect(winnersCount).to.equal(stock, 
            `Expected ${stock} winners, got ${winnersCount}`)

          // 4. Out of stock count should be totalRequests - stock
          expect(outOfStockCount).to.equal(totalRequests - stock,
            `Expected ${totalRequests - stock} out of stock responses, got ${outOfStockCount}`)

          // Clean up
          await client.del(`seckill:test:${productId}:stock`)
          await client.del(`seckill:test:${productId}:users`)
        }
      ),
      { 
        numRuns: 100,
        verbose: true
      }
    )
  })

  // Additional edge case: Stock of 1 with many concurrent requests
  it('should handle stock of 1 with many concurrent requests correctly', async function () {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10, max: 200 }),
        async (numRequests) => {
          const productId = `product-single-${Date.now()}-${Math.random().toString(36).slice(2)}`
          const stock = 1

          await initCampaign(productId, stock)

          const userIds = Array.from({ length: numRequests }, (_, i) => `user-single-${i}`)

          const results = await Promise.all(
            userIds.map(userId => executeReserve(productId, userId))
          )

          const successCount = results.filter(r => r === 1).length
          const finalStock = await getStock(productId)

          // Exactly 1 purchase should succeed
          expect(successCount).to.equal(1)
          expect(finalStock).to.equal(0)

          // Clean up
          await client.del(`seckill:test:${productId}:stock`)
          await client.del(`seckill:test:${productId}:users`)
        }
      ),
      { numRuns: 50 }
    )
  })

  // Test that duplicate purchases are prevented
  it('should prevent duplicate purchases from the same user', async function () {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 2, max: 10 }),
        async (stock, duplicateAttempts) => {
          const productId = `product-dup-${Date.now()}-${Math.random().toString(36).slice(2)}`
          const userId = 'duplicate-user'

          await initCampaign(productId, stock)

          // Same user tries multiple times
          const results = []
          for (let i = 0; i < duplicateAttempts; i++) {
            const result = await executeReserve(productId, userId)
            results.push(result)
          }

          // Only first attempt should succeed
          expect(results[0]).to.equal(1, 'First attempt should succeed')
          
          // All subsequent attempts should return ALREADY_PURCHASED (-2)
          for (let i = 1; i < results.length; i++) {
            expect(results[i]).to.equal(-2, `Attempt ${i + 1} should return ALREADY_PURCHASED`)
          }

          // Stock should only decrease by 1
          const finalStock = await getStock(productId)
          expect(finalStock).to.equal(stock - 1)

          // Clean up
          await client.del(`seckill:test:${productId}:stock`)
          await client.del(`seckill:test:${productId}:users`)
        }
      ),
      { numRuns: 50 }
    )
  })
})
