/**
 * Property-Based Tests for Seckill Service - Release Properties (7, 8, 9)
 * 
 * Property 7: Slot Release Restores Stock
 * Property 8: Idempotent Slot Release
 * Property 9: Buy-Release Round Trip
 */

const { describe, it, before, after, beforeEach } = require('mocha')
const { expect } = require('chai')
const fc = require('fast-check')

const {
  createRedisClient,
  initCampaign,
  getStatus,
  getWinnersCount,
  isUserInWinners,
  cleanupTestKeys,
  loadLuaScripts,
  executeBuy,
  executeRelease,
  generateProductId,
  activeCampaignArb,
  userIdArb,
  uniqueUserIdsArb,
} = require('./helpers/testHelpers')

describe('Seckill Release Property Tests', function () {
  this.timeout(60000)

  let client
  let reserveSHA
  let releaseSHA

  before(async function () {
    try {
      client = await createRedisClient()
      const scripts = await loadLuaScripts(client)
      reserveSHA = scripts.reserveSHA
      releaseSHA = scripts.releaseSHA
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
   * **Feature: seckill-service, Property 7: Slot Release Restores Stock**
   * 
   * *For any* user who has a reserved slot (exists in winners set), releasing the slot
   * SHALL atomically remove the userId from the winners set, increment stock by 1,
   * and publish a seckill.released event.
   * 
   * **Validates: Requirements 5.1, 5.3, 6.3**
   */
  describe('Property 7: Slot Release Restores Stock', function () {
    it('should restore stock and remove user from winners set when slot is released', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          userIdArb,
          async (campaignParams, userId) => {
            const productId = generateProductId('release')

            await initCampaign(client, productId, campaignParams)

            const buyResult = await executeBuy(client, reserveSHA, productId, userId)
            expect(buyResult).to.equal(1, 'Buy operation should succeed')

            const statusAfterBuy = await getStatus(client, productId)
            const stockAfterBuy = statusAfterBuy.stockRemaining
            const userInWinnersAfterBuy = await isUserInWinners(client, productId, userId)
            
            expect(userInWinnersAfterBuy).to.be.true
            expect(stockAfterBuy).to.equal(campaignParams.stock - 1)

            const releaseResult = await executeRelease(client, releaseSHA, productId, userId)
            expect(releaseResult).to.equal(1, 'Release operation should succeed')

            const statusAfterRelease = await getStatus(client, productId)
            const stockAfterRelease = statusAfterRelease.stockRemaining
            const userInWinnersAfterRelease = await isUserInWinners(client, productId, userId)

            expect(stockAfterRelease).to.equal(stockAfterBuy + 1)
            expect(userInWinnersAfterRelease).to.be.false
            expect(stockAfterRelease).to.equal(campaignParams.stock)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should maintain stock invariant after buy and release: initial_stock = final_stock', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          uniqueUserIdsArb.filter(arr => arr.length <= 10),
          async (campaignParams, userIds) => {
            const productId = generateProductId('release-inv')

            const adjustedParams = {
              ...campaignParams,
              stock: Math.max(campaignParams.stock, userIds.length)
            }

            await initCampaign(client, productId, adjustedParams)

            for (const userId of userIds) {
              const result = await executeBuy(client, reserveSHA, productId, userId)
              expect(result).to.equal(1, `User ${userId} should be able to buy`)
            }

            const statusAfterBuys = await getStatus(client, productId)
            expect(statusAfterBuys.stockRemaining).to.equal(adjustedParams.stock - userIds.length)

            for (const userId of userIds) {
              const result = await executeRelease(client, releaseSHA, productId, userId)
              expect(result).to.equal(1, `User ${userId} release should succeed`)
            }

            const finalStatus = await getStatus(client, productId)
            expect(finalStatus.stockRemaining).to.equal(adjustedParams.stock)

            const winnersCount = await getWinnersCount(client, productId)
            expect(winnersCount).to.equal(0)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })
  })

  /**
   * **Feature: seckill-service, Property 8: Idempotent Slot Release**
   * 
   * *For any* release request for a user who does not have a reserved slot
   * (not in winners set), the operation SHALL complete without error and
   * without modifying stock.
   * 
   * **Validates: Requirements 5.2**
   */
  describe('Property 8: Idempotent Slot Release', function () {
    it('should complete without error when releasing non-existent slot', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          userIdArb,
          async (campaignParams, userId) => {
            const productId = generateProductId('idempotent')

            await initCampaign(client, productId, campaignParams)

            const initialStatus = await getStatus(client, productId)
            const initialStock = initialStatus.stockRemaining

            const releaseResult = await executeRelease(client, releaseSHA, productId, userId)
            expect(releaseResult).to.equal(-1, 'Release should return USER_NOT_FOUND (-1)')

            const finalStatus = await getStatus(client, productId)
            const finalStock = finalStatus.stockRemaining

            expect(finalStock).to.equal(initialStock)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should be idempotent when releasing same slot multiple times', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          userIdArb,
          fc.integer({ min: 2, max: 5 }),
          async (campaignParams, userId, releaseAttempts) => {
            const productId = generateProductId('multi-release')

            await initCampaign(client, productId, campaignParams)

            const buyResult = await executeBuy(client, reserveSHA, productId, userId)
            expect(buyResult).to.equal(1, 'Buy should succeed')

            const firstRelease = await executeRelease(client, releaseSHA, productId, userId)
            expect(firstRelease).to.equal(1, 'First release should succeed')

            const statusAfterFirst = await getStatus(client, productId)
            const stockAfterFirst = statusAfterFirst.stockRemaining

            for (let i = 0; i < releaseAttempts; i++) {
              const result = await executeRelease(client, releaseSHA, productId, userId)
              expect(result).to.equal(-1, `Release attempt ${i + 2} should return USER_NOT_FOUND`)
            }

            const finalStatus = await getStatus(client, productId)
            const finalStock = finalStatus.stockRemaining

            expect(finalStock).to.equal(stockAfterFirst)
            expect(finalStock).to.equal(campaignParams.stock)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })
  })

  /**
   * **Feature: seckill-service, Property 9: Buy-Release Round Trip**
   * 
   * *For any* user who successfully purchases from a campaign, releasing their slot
   * SHALL restore the campaign to a state where the user can purchase again and
   * stock is incremented.
   * 
   * **Validates: Requirements 5.1, 2.1**
   */
  describe('Property 9: Buy-Release Round Trip', function () {
    it('should allow user to buy again after releasing their slot', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          userIdArb,
          async (campaignParams, userId) => {
            const productId = generateProductId('roundtrip-buy')

            await initCampaign(client, productId, campaignParams)

            const firstBuy = await executeBuy(client, reserveSHA, productId, userId)
            expect(firstBuy).to.equal(1, 'First buy should succeed')

            const inWinnersAfterFirstBuy = await isUserInWinners(client, productId, userId)
            expect(inWinnersAfterFirstBuy).to.be.true

            const statusAfterFirstBuy = await getStatus(client, productId)
            expect(statusAfterFirstBuy.stockRemaining).to.equal(campaignParams.stock - 1)

            const release = await executeRelease(client, releaseSHA, productId, userId)
            expect(release).to.equal(1, 'Release should succeed')

            const inWinnersAfterRelease = await isUserInWinners(client, productId, userId)
            expect(inWinnersAfterRelease).to.be.false

            const statusAfterRelease = await getStatus(client, productId)
            expect(statusAfterRelease.stockRemaining).to.equal(campaignParams.stock)

            const secondBuy = await executeBuy(client, reserveSHA, productId, userId)
            expect(secondBuy).to.equal(1, 'Second buy should succeed after release')

            const inWinnersAfterSecondBuy = await isUserInWinners(client, productId, userId)
            expect(inWinnersAfterSecondBuy).to.be.true

            const finalStatus = await getStatus(client, productId)
            expect(finalStatus.stockRemaining).to.equal(campaignParams.stock - 1)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should support multiple buy-release cycles', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          userIdArb,
          fc.integer({ min: 2, max: 5 }),
          async (campaignParams, userId, cycles) => {
            const productId = generateProductId('multi-cycle')

            await initCampaign(client, productId, campaignParams)

            for (let i = 0; i < cycles; i++) {
              const buyResult = await executeBuy(client, reserveSHA, productId, userId)
              expect(buyResult).to.equal(1, `Cycle ${i + 1}: Buy should succeed`)

              const statusAfterBuy = await getStatus(client, productId)
              expect(statusAfterBuy.stockRemaining).to.equal(campaignParams.stock - 1)

              const inWinners = await isUserInWinners(client, productId, userId)
              expect(inWinners).to.be.true

              const releaseResult = await executeRelease(client, releaseSHA, productId, userId)
              expect(releaseResult).to.equal(1, `Cycle ${i + 1}: Release should succeed`)

              const statusAfterRelease = await getStatus(client, productId)
              expect(statusAfterRelease.stockRemaining).to.equal(campaignParams.stock)

              const notInWinners = await isUserInWinners(client, productId, userId)
              expect(notInWinners).to.be.false
            }

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })
  })
})
