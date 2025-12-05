/**
 * Property-Based Tests for Seckill Service - Purchase Properties (4, 5)
 * 
 * Property 4: Successful Purchase Decrements Stock and Records User
 * Property 5: Duplicate Purchase Prevention
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
  generateProductId,
  activeCampaignArb,
  userIdArb,
} = require('./helpers/testHelpers')

describe('Seckill Purchase Property Tests', function () {
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
   * **Feature: seckill-service, Property 4: Successful Purchase Decrements Stock and Records User**
   * 
   * *For any* authenticated user and active campaign with stock > 0 where the user has
   * not previously purchased, executing a buy operation SHALL result in stock decremented
   * by 1, the userId added to the winners set, and a seckill.order.won event published.
   * 
   * **Validates: Requirements 2.1, 6.1**
   */
  describe('Property 4: Successful Purchase Decrements Stock and Records User', function () {
    it('should decrement stock by 1 and add user to winners set on successful purchase', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          userIdArb,
          async (campaignParams, userId) => {
            const productId = generateProductId('buy')

            await initCampaign(client, productId, campaignParams)

            const initialStatus = await getStatus(client, productId)
            const initialStock = initialStatus.stockRemaining
            const userInWinnersBefore = await isUserInWinners(client, productId, userId)

            expect(initialStock).to.be.greaterThan(0)
            expect(userInWinnersBefore).to.be.false

            const result = await executeBuy(client, reserveSHA, productId, userId)
            expect(result).to.equal(1, 'Buy operation should succeed')

            const finalStatus = await getStatus(client, productId)
            const userInWinnersAfter = await isUserInWinners(client, productId, userId)

            expect(finalStatus.stockRemaining).to.equal(initialStock - 1)
            expect(userInWinnersAfter).to.be.true

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should correctly handle multiple unique users purchasing from same campaign', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 5, max: 50 }),
          fc.integer({ min: 1, max: 5 }),
          async (stock, numUsers) => {
            const actualNumUsers = Math.min(numUsers, stock)
            const productId = generateProductId('multi-buy')

            const campaignParams = {
              stock,
              price: 99.99,
              startTime: new Date(Date.now() - 3600000).toISOString(),
              endTime: new Date(Date.now() + 3600000).toISOString(),
            }

            await initCampaign(client, productId, campaignParams)

            const userIds = Array.from({ length: actualNumUsers }, (_, i) => `multi-user-${i}-${Date.now()}`)

            const results = []
            for (const userId of userIds) {
              const result = await executeBuy(client, reserveSHA, productId, userId)
              results.push({ userId, result })
            }

            const finalStatus = await getStatus(client, productId)
            const winnersCount = await getWinnersCount(client, productId)

            const successCount = results.filter(r => r.result === 1).length
            expect(successCount).to.equal(actualNumUsers)
            expect(finalStatus.stockRemaining).to.equal(stock - actualNumUsers)
            expect(winnersCount).to.equal(actualNumUsers)

            for (const userId of userIds) {
              const isWinner = await isUserInWinners(client, productId, userId)
              expect(isWinner).to.be.true
            }

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should maintain stock invariant: initial_stock = final_stock + winners_count', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 20 }),
          async (stock, numAttempts) => {
            const productId = generateProductId('invariant')

            const campaignParams = {
              stock,
              price: 49.99,
              startTime: new Date(Date.now() - 3600000).toISOString(),
              endTime: new Date(Date.now() + 3600000).toISOString(),
            }

            await initCampaign(client, productId, campaignParams)

            const userIds = Array.from({ length: numAttempts }, (_, i) => `inv-user-${i}-${Date.now()}`)

            for (const userId of userIds) {
              await executeBuy(client, reserveSHA, productId, userId)
            }

            const finalStatus = await getStatus(client, productId)
            const winnersCount = await getWinnersCount(client, productId)

            expect(finalStatus.stockRemaining + winnersCount).to.equal(stock)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })
  })

  /**
   * **Feature: seckill-service, Property 5: Duplicate Purchase Prevention**
   * 
   * *For any* user who has already successfully purchased from a campaign,
   * subsequent purchase attempts SHALL be rejected with ALREADY_PURCHASED error
   * without modifying stock.
   * 
   * **Validates: Requirements 2.3**
   */
  describe('Property 5: Duplicate Purchase Prevention', function () {
    it('should reject second purchase attempt with ALREADY_PURCHASED error and not modify stock', async function () {
      const activeCampaignArb2 = fc.record({
        stock: fc.integer({ min: 2, max: 1000 }),
        priceCents: fc.integer({ min: 1, max: 9999999 }),
      }).map(({ stock, priceCents }) => {
        const now = Date.now()
        const startTime = new Date(now - 3600000).toISOString()
        const endTime = new Date(now + 3600000).toISOString()
        const price = priceCents / 100
        return { stock, price, startTime, endTime }
      })

      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb2,
          userIdArb,
          async (campaignParams, userId) => {
            const productId = generateProductId('dup')

            await initCampaign(client, productId, campaignParams)

            const firstResult = await executeBuy(client, reserveSHA, productId, userId)
            expect(firstResult).to.equal(1, 'First purchase should succeed')

            const statusAfterFirst = await getStatus(client, productId)
            const stockAfterFirst = statusAfterFirst.stockRemaining

            const userInWinnersAfterFirst = await isUserInWinners(client, productId, userId)
            expect(userInWinnersAfterFirst).to.be.true

            const secondResult = await executeBuy(client, reserveSHA, productId, userId)
            expect(secondResult).to.equal(-2, 'Second purchase should return ALREADY_PURCHASED (-2)')

            const statusAfterSecond = await getStatus(client, productId)
            const stockAfterSecond = statusAfterSecond.stockRemaining

            expect(stockAfterSecond).to.equal(stockAfterFirst)

            const userInWinnersAfterSecond = await isUserInWinners(client, productId, userId)
            expect(userInWinnersAfterSecond).to.be.true

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should reject multiple subsequent purchase attempts without modifying stock', async function () {
      const activeCampaignArb2 = fc.record({
        stock: fc.integer({ min: 2, max: 1000 }),
        priceCents: fc.integer({ min: 1, max: 9999999 }),
      }).map(({ stock, priceCents }) => {
        const now = Date.now()
        const startTime = new Date(now - 3600000).toISOString()
        const endTime = new Date(now + 3600000).toISOString()
        const price = priceCents / 100
        return { stock, price, startTime, endTime }
      })

      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb2,
          userIdArb,
          fc.integer({ min: 2, max: 10 }),
          async (campaignParams, userId, additionalAttempts) => {
            const productId = generateProductId('multi-dup')

            await initCampaign(client, productId, campaignParams)

            const firstResult = await executeBuy(client, reserveSHA, productId, userId)
            expect(firstResult).to.equal(1, 'First purchase should succeed')

            const statusAfterFirst = await getStatus(client, productId)
            const stockAfterFirst = statusAfterFirst.stockRemaining

            for (let i = 0; i < additionalAttempts; i++) {
              const result = await executeBuy(client, reserveSHA, productId, userId)
              expect(result).to.equal(-2)
            }

            const finalStatus = await getStatus(client, productId)
            expect(finalStatus.stockRemaining).to.equal(stockAfterFirst)

            const winnersCount = await getWinnersCount(client, productId)
            expect(winnersCount).to.equal(1)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })

    it('should correctly distinguish between different users (no false duplicate detection)', async function () {
      await fc.assert(
        fc.asyncProperty(
          activeCampaignArb,
          fc.array(
            fc.string({ minLength: 1, maxLength: 20 })
              .filter(s => s.trim().length > 0 && !s.includes(':'))
              .map(s => `user-${s}`),
            { minLength: 2, maxLength: 10 }
          ).map(arr => [...new Set(arr)]).filter(arr => arr.length >= 2),
          async (campaignParams, userIds) => {
            const productId = generateProductId('diff-users')

            const adjustedParams = {
              ...campaignParams,
              stock: Math.max(campaignParams.stock, userIds.length)
            }

            await initCampaign(client, productId, adjustedParams)

            for (const userId of userIds) {
              const result = await executeBuy(client, reserveSHA, productId, userId)
              expect(result).to.equal(1, `User ${userId} should be able to purchase`)
            }

            for (const userId of userIds) {
              const isWinner = await isUserInWinners(client, productId, userId)
              expect(isWinner).to.be.true
            }

            const finalStatus = await getStatus(client, productId)
            expect(finalStatus.stockRemaining).to.equal(adjustedParams.stock - userIds.length)

            await cleanupTestKeys(client, productId)
          }
        ),
        { numRuns: 100, verbose: true }
      )
    })
  })
})
