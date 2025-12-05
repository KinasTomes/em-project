/**
 * Property-Based Tests for Seckill Service - Concurrency Property (6)
 * 
 * Property 6: No Overselling Under Concurrency
 */

const { describe, it, before, after, beforeEach } = require('mocha')
const { expect } = require('chai')
const fc = require('fast-check')

const {
  createRedisClient,
  initCampaign,
  getStatus,
  getWinnersCount,
  cleanupTestKeys,
  loadLuaScripts,
  executeBuy,
  generateProductId,
} = require('./helpers/testHelpers')

describe('Seckill Concurrency Property Tests', function () {
  this.timeout(60000)

  let client
  let reserveSHA

  before(async function () {
    try {
      client = await createRedisClient()
      const scripts = await loadLuaScripts(client)
      reserveSHA = scripts.reserveSHA
    } catch (err) {
      console.log('Redis not available, skipping tests')
      this.skip()
    }
  })

  after(async function () {
    if (client && client.isOpen) {
      await client.quit()
    }
  })

  beforeEach(async function () {
    const keys = await client.keys('seckill:test:*')
    if (keys.length > 0) {
      await client.del(keys)
    }
  })

  /**
   * **Feature: seckill-service, Property 6: No Overselling Under Concurrency**
   * 
   * *For any* campaign with initial stock N and M concurrent purchase requests where M > N,
   * the total number of successful purchases SHALL be exactly N (no more, no less),
   * and the final stock SHALL be 0.
   * 
   * **Validates: Requirements 4.1**
   */
  describe('Property 6: No Overselling Under Concurrency', function () {
    it('should allow exactly N successful purchases for stock N with M > N concurrent requests', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 50 }),  // stock N
          fc.integer({ min: 10, max: 100 }), // requests M (always > N due to min)
          async (stock, extraRequests) => {
            const totalRequests = stock + extraRequests // M > N
            const productId = generateProductId('concurrent')

            const campaignParams = {
              stock,
              price: 99.99,
              startTime: new Date(Date.now() - 3600000).toISOString(),
              endTime: new Date(Date.now() + 3600000).toISOString(),
            }

            await initCampaign(client, productId, campaignParams)

            // Generate unique user IDs
            const userIds = Array.from({ length: totalRequests }, (_, i) => `concurrent-user-${i}-${Date.now()}`)

            // Execute all purchases concurrently
            const results = await Promise.all(
              userIds.map(userId => executeBuy(client, reserveSHA, productId, userId))
            )

            // Count successes and failures
            const successCount = results.filter(r => r === 1).length
            const outOfStockCount = results.filter(r => r === -1).length

            // Property assertions:
            // 1. Exactly N purchases should succeed
            expect(successCount).to.equal(stock,
              `Expected exactly ${stock} successful purchases, got ${successCount}`)

            // 2. Remaining requests should fail with OUT_OF_STOCK
            expect(outOfStockCount).to.equal(totalRequests - stock,
              `Expected ${totalRequests - stock} OUT_OF_STOCK failures, got ${outOfStockCount}`)

            // 3. Final stock should be 0
            const finalStatus = await getStatus(client, productId)
            expect(finalStatus.stockRemaining).to.equal(0,
              `Final stock should be 0, got ${finalStatus.stockRemaining}`)

            // 4. Winners count should equal stock
            const winnersCount = await getWinnersCount(client, productId)
            expect(winnersCount).to.equal(stock,
              `Winners count should be ${stock}, got ${winnersCount}`)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })

    it('should handle stock of 1 with many concurrent requests correctly', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 50 }), // number of concurrent requests
          async (numRequests) => {
            const productId = generateProductId('single-stock')

            const campaignParams = {
              stock: 1,
              price: 199.99,
              startTime: new Date(Date.now() - 3600000).toISOString(),
              endTime: new Date(Date.now() + 3600000).toISOString(),
            }

            await initCampaign(client, productId, campaignParams)

            const userIds = Array.from({ length: numRequests }, (_, i) => `single-user-${i}-${Date.now()}`)

            const results = await Promise.all(
              userIds.map(userId => executeBuy(client, reserveSHA, productId, userId))
            )

            const successCount = results.filter(r => r === 1).length

            // Exactly 1 purchase should succeed
            expect(successCount).to.equal(1)

            const finalStatus = await getStatus(client, productId)
            expect(finalStatus.stockRemaining).to.equal(0)

            const winnersCount = await getWinnersCount(client, productId)
            expect(winnersCount).to.equal(1)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })

    it('should prevent duplicate purchases from the same user', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 5, max: 20 }), // stock
          fc.integer({ min: 2, max: 10 }), // attempts per user
          async (stock, attemptsPerUser) => {
            const productId = generateProductId('dup-concurrent')

            const campaignParams = {
              stock,
              price: 49.99,
              startTime: new Date(Date.now() - 3600000).toISOString(),
              endTime: new Date(Date.now() + 3600000).toISOString(),
            }

            await initCampaign(client, productId, campaignParams)

            // Create fewer users than stock, but each tries multiple times
            const numUsers = Math.ceil(stock / 2)
            const userIds = Array.from({ length: numUsers }, (_, i) => `dup-user-${i}-${Date.now()}`)

            // Each user attempts multiple purchases concurrently
            const allAttempts = userIds.flatMap(userId =>
              Array.from({ length: attemptsPerUser }, () => userId)
            )

            const results = await Promise.all(
              allAttempts.map(userId => executeBuy(client, reserveSHA, productId, userId))
            )

            // Count successes per user
            const successesByUser = {}
            allAttempts.forEach((userId, i) => {
              if (results[i] === 1) {
                successesByUser[userId] = (successesByUser[userId] || 0) + 1
              }
            })

            // Each user should have at most 1 success
            for (const [userId, count] of Object.entries(successesByUser)) {
              expect(count).to.equal(1, `User ${userId} should have exactly 1 success, got ${count}`)
            }

            // Total successes should equal number of unique successful users
            const totalSuccesses = results.filter(r => r === 1).length
            expect(totalSuccesses).to.equal(Object.keys(successesByUser).length)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })
  })
})
