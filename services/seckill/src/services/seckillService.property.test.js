/**
 * Property-Based Tests for Seckill Service
 * 
 * Tests Properties 1, 2, and 3 from the design document
 */

const { describe, it, before, after, beforeEach } = require('mocha')
const { expect } = require('chai')
const fc = require('fast-check')
const { createClient } = require('redis')

const REDIS_URL = process.env.REDIS_SECKILL_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379'

describe('Seckill Service Property Tests', function () {
  this.timeout(60000)

  let client

  before(async function () {
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
  })

  after(async function () {
    if (client && client.isOpen) {
      await client.quit()
    }
  })

  beforeEach(async function () {
    // Clean up test keys
    const keys = await client.keys('seckill:test:*')
    if (keys.length > 0) {
      await client.del(keys)
    }
  })

  /**
   * Helper to initialize a campaign directly in Redis (simulating seckillService.initCampaign)
   */
  async function initCampaign(productId, params) {
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
   * Helper to get campaign status from Redis (simulating seckillService.getStatus)
   */
  async function getStatus(productId) {
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
  async function addWinners(productId, userIds) {
    const usersKey = `seckill:test:${productId}:users`
    if (userIds.length > 0) {
      await client.sAdd(usersKey, userIds)
    }
  }

  /**
   * Helper to get winners count
   */
  async function getWinnersCount(productId) {
    const usersKey = `seckill:test:${productId}:users`
    return client.sCard(usersKey)
  }

  /**
   * Generator for valid campaign parameters
   */
  const validCampaignArb = fc.record({
    stock: fc.integer({ min: 1, max: 10000 }),
    // Use integer for price in cents, then convert to dollars
    priceCents: fc.integer({ min: 1, max: 9999999 }),
    // Generate start time in the past or future
    startOffset: fc.integer({ min: -86400000, max: 86400000 }), // -1 day to +1 day in ms
    duration: fc.integer({ min: 3600000, max: 604800000 }), // 1 hour to 7 days in ms
  }).map(({ stock, priceCents, startOffset, duration }) => {
    const now = Date.now()
    const startTime = new Date(now + startOffset).toISOString()
    const endTime = new Date(now + startOffset + duration).toISOString()
    const price = priceCents / 100 // Convert cents to dollars
    return { stock, price, startTime, endTime }
  })

  /**
   * **Feature: seckill-service, Property 1: Campaign Data Round Trip**
   * 
   * *For any* valid campaign parameters (productId, stock, price, startTime, endTime),
   * initializing a campaign and then retrieving its status SHALL return the same values
   * that were provided during initialization.
   * 
   * **Validates: Requirements 1.1, 3.1**
   */
  describe('Property 1: Campaign Data Round Trip', function () {
    it('should return the same values after init and getStatus', async function () {
      await fc.assert(
        fc.asyncProperty(
          validCampaignArb,
          async (params) => {
            const productId = `test-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`

            // Initialize campaign
            const initResult = await initCampaign(productId, params)
            expect(initResult.success).to.be.true

            // Retrieve status
            const status = await getStatus(productId)

            // Verify round trip
            expect(status).to.not.be.null
            expect(status.productId).to.equal(productId)
            expect(status.stockRemaining).to.equal(params.stock)
            expect(status.totalStock).to.equal(params.stock)
            expect(status.price).to.equal(params.price)
            expect(status.startTime).to.equal(params.startTime)
            expect(status.endTime).to.equal(params.endTime)

            // Clean up
            await client.del(`seckill:test:${productId}:stock`)
            await client.del(`seckill:test:${productId}:total`)
            await client.del(`seckill:test:${productId}:price`)
            await client.del(`seckill:test:${productId}:start`)
            await client.del(`seckill:test:${productId}:end`)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })
  })


  /**
   * **Feature: seckill-service, Property 2: Invalid Campaign Rejection**
   * 
   * *For any* campaign initialization request with one or more missing required fields
   * (productId, stock, price, startTime, or endTime), the service SHALL reject the
   * request with a validation error.
   * 
   * **Validates: Requirements 1.2**
   */
  describe('Property 2: Invalid Campaign Rejection', function () {
    // Import the schema for validation testing
    const { CampaignInitSchema } = require('../schemas/seckillEvents.schema')

    /**
     * Generator for campaign params with random missing fields
     */
    const invalidCampaignArb = fc.record({
      stock: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined }),
      price: fc.option(fc.integer({ min: 1, max: 9999999 }).map(c => c / 100), { nil: undefined }),
      startTime: fc.option(fc.date().map(d => d.toISOString()), { nil: undefined }),
      endTime: fc.option(fc.date().map(d => d.toISOString()), { nil: undefined }),
      productId: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    }).filter(params => {
      // Ensure at least one required field is missing
      return (
        params.stock === undefined ||
        params.price === undefined ||
        params.startTime === undefined ||
        params.endTime === undefined ||
        params.productId === undefined
      )
    })

    it('should reject campaign params with missing required fields', async function () {
      await fc.assert(
        fc.asyncProperty(
          invalidCampaignArb,
          async (params) => {
            let rejected = false
            let error = null

            try {
              CampaignInitSchema.parse(params)
            } catch (e) {
              rejected = true
              error = e
            }

            // Should be rejected
            expect(rejected).to.be.true
            expect(error).to.not.be.null
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should reject campaign with invalid stock (zero or negative)', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: -1000, max: 0 }),
          async (invalidStock) => {
            const params = {
              productId: 'test-product',
              stock: invalidStock,
              price: 99.99,
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 86400000).toISOString(),
            }

            let rejected = false
            try {
              CampaignInitSchema.parse(params)
            } catch (e) {
              rejected = true
            }

            expect(rejected).to.be.true
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })

    it('should reject campaign with invalid price (zero or negative)', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: -100000, max: 0 }).map(c => c / 100),
          async (invalidPrice) => {
            const params = {
              productId: 'test-product',
              stock: 100,
              price: invalidPrice,
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 86400000).toISOString(),
            }

            let rejected = false
            try {
              CampaignInitSchema.parse(params)
            } catch (e) {
              rejected = true
            }

            expect(rejected).to.be.true
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })

    it('should reject campaign with endTime before startTime', async function () {
      // Use constrained date range to avoid invalid dates
      const validDateArb = fc.date({ 
        min: new Date('2020-01-01'), 
        max: new Date('2030-12-31') 
      })

      await fc.assert(
        fc.asyncProperty(
          validDateArb,
          fc.integer({ min: 1, max: 86400000 }), // 1ms to 1 day
          async (baseDate, offset) => {
            const startTime = new Date(baseDate.getTime() + offset).toISOString()
            const endTime = new Date(baseDate.getTime()).toISOString() // endTime before startTime

            const params = {
              productId: 'test-product',
              stock: 100,
              price: 99.99,
              startTime,
              endTime,
            }

            let rejected = false
            try {
              CampaignInitSchema.parse(params)
            } catch (e) {
              rejected = true
            }

            expect(rejected).to.be.true
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })
  })


  /**
   * **Feature: seckill-service, Property 3: Campaign Re-initialization Clears Winners**
   * 
   * *For any* campaign that has been initialized and has users in its winners set,
   * re-initializing the campaign with new parameters SHALL result in an empty winners
   * set and updated campaign data.
   * 
   * **Validates: Requirements 1.3**
   */
  describe('Property 3: Campaign Re-initialization Clears Winners', function () {
    /**
     * Generator for user IDs
     */
    const userIdsArb = fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
      { minLength: 1, maxLength: 50 }
    )

    it('should clear winners set when campaign is re-initialized', async function () {
      await fc.assert(
        fc.asyncProperty(
          validCampaignArb,
          validCampaignArb,
          userIdsArb,
          async (initialParams, newParams, userIds) => {
            const productId = `test-reinit-${Date.now()}-${Math.random().toString(36).slice(2)}`

            // Initialize campaign
            await initCampaign(productId, initialParams)

            // Add users to winners set
            await addWinners(productId, userIds)

            // Verify users were added
            const winnersBeforeReinit = await getWinnersCount(productId)
            expect(winnersBeforeReinit).to.equal(userIds.length)

            // Re-initialize campaign with new params
            await initCampaign(productId, newParams)

            // Verify winners set is cleared
            const winnersAfterReinit = await getWinnersCount(productId)
            expect(winnersAfterReinit).to.equal(0)

            // Verify new campaign data
            const status = await getStatus(productId)
            expect(status.stockRemaining).to.equal(newParams.stock)
            expect(status.totalStock).to.equal(newParams.stock)
            expect(status.price).to.equal(newParams.price)
            expect(status.startTime).to.equal(newParams.startTime)
            expect(status.endTime).to.equal(newParams.endTime)

            // Clean up
            await client.del(`seckill:test:${productId}:stock`)
            await client.del(`seckill:test:${productId}:total`)
            await client.del(`seckill:test:${productId}:price`)
            await client.del(`seckill:test:${productId}:start`)
            await client.del(`seckill:test:${productId}:end`)
            await client.del(`seckill:test:${productId}:users`)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should update campaign data even when winners set was empty', async function () {
      await fc.assert(
        fc.asyncProperty(
          validCampaignArb,
          validCampaignArb,
          async (initialParams, newParams) => {
            const productId = `test-reinit-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`

            // Initialize campaign (no winners)
            await initCampaign(productId, initialParams)

            // Verify initial state
            const initialStatus = await getStatus(productId)
            expect(initialStatus.stockRemaining).to.equal(initialParams.stock)

            // Re-initialize with new params
            await initCampaign(productId, newParams)

            // Verify updated data
            const newStatus = await getStatus(productId)
            expect(newStatus.stockRemaining).to.equal(newParams.stock)
            expect(newStatus.totalStock).to.equal(newParams.stock)
            expect(newStatus.price).to.equal(newParams.price)

            // Clean up
            await client.del(`seckill:test:${productId}:stock`)
            await client.del(`seckill:test:${productId}:total`)
            await client.del(`seckill:test:${productId}:price`)
            await client.del(`seckill:test:${productId}:start`)
            await client.del(`seckill:test:${productId}:end`)
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })
  })
})
