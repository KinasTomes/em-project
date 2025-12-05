/**
 * Property-Based Tests for Seckill Service - Campaign Properties (1, 2, 3)
 * 
 * Property 1: Campaign Data Round Trip
 * Property 2: Invalid Campaign Rejection
 * Property 3: Campaign Re-initialization Clears Winners
 */

const { describe, it, before, after, beforeEach } = require('mocha')
const { expect } = require('chai')
const fc = require('fast-check')

const {
  createRedisClient,
  initCampaign,
  getStatus,
  addWinners,
  getWinnersCount,
  cleanupTestKeys,
  generateProductId,
  validCampaignArb,
  uniqueUserIdsArb,
} = require('./helpers/testHelpers')

describe('Seckill Campaign Property Tests', function () {
  this.timeout(60000)

  let client

  before(async function () {
    try {
      client = await createRedisClient()
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
            const productId = generateProductId('roundtrip')

            const initResult = await initCampaign(client, productId, params)
            expect(initResult.success).to.be.true

            const status = await getStatus(client, productId)

            expect(status).to.not.be.null
            expect(status.productId).to.equal(productId)
            expect(status.stockRemaining).to.equal(params.stock)
            expect(status.totalStock).to.equal(params.stock)
            expect(status.price).to.equal(params.price)
            expect(status.startTime).to.equal(params.startTime)
            expect(status.endTime).to.equal(params.endTime)

            await cleanupTestKeys(client, productId)
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
    const { CampaignInitSchema } = require('../schemas/seckillEvents.schema')

    const invalidCampaignArb = fc.record({
      stock: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined }),
      price: fc.option(fc.integer({ min: 1, max: 9999999 }).map(c => c / 100), { nil: undefined }),
      startTime: fc.option(fc.date().map(d => d.toISOString()), { nil: undefined }),
      endTime: fc.option(fc.date().map(d => d.toISOString()), { nil: undefined }),
      productId: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    }).filter(params => {
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
            try {
              CampaignInitSchema.parse(params)
            } catch (e) {
              rejected = true
            }
            expect(rejected).to.be.true
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
      const validDateArb = fc.date({ 
        min: new Date('2020-01-01'), 
        max: new Date('2030-12-31') 
      })

      await fc.assert(
        fc.asyncProperty(
          validDateArb,
          fc.integer({ min: 1, max: 86400000 }),
          async (baseDate, offset) => {
            const startTime = new Date(baseDate.getTime() + offset).toISOString()
            const endTime = new Date(baseDate.getTime()).toISOString()

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
    // FIX: Use uniqueUserIdsArb to ensure no duplicate user IDs
    it('should clear winners set when campaign is re-initialized', async function () {
      await fc.assert(
        fc.asyncProperty(
          validCampaignArb,
          validCampaignArb,
          uniqueUserIdsArb,
          async (initialParams, newParams, userIds) => {
            const productId = generateProductId('reinit')

            await initCampaign(client, productId, initialParams)
            await addWinners(client, productId, userIds)

            // Verify users were added (use unique count)
            const winnersBeforeReinit = await getWinnersCount(client, productId)
            expect(winnersBeforeReinit).to.equal(userIds.length)

            await initCampaign(client, productId, newParams)

            const winnersAfterReinit = await getWinnersCount(client, productId)
            expect(winnersAfterReinit).to.equal(0)

            const status = await getStatus(client, productId)
            expect(status.stockRemaining).to.equal(newParams.stock)
            expect(status.totalStock).to.equal(newParams.stock)
            expect(status.price).to.equal(newParams.price)
            expect(status.startTime).to.equal(newParams.startTime)
            expect(status.endTime).to.equal(newParams.endTime)

            await cleanupTestKeys(client, productId)
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
            const productId = generateProductId('reinit-empty')

            await initCampaign(client, productId, initialParams)

            const initialStatus = await getStatus(client, productId)
            expect(initialStatus.stockRemaining).to.equal(initialParams.stock)

            await initCampaign(client, productId, newParams)

            const newStatus = await getStatus(client, productId)
            expect(newStatus.stockRemaining).to.equal(newParams.stock)
            expect(newStatus.totalStock).to.equal(newParams.stock)
            expect(newStatus.price).to.equal(newParams.price)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 50, verbose: true }
      )
    })
  })
})
