const { z } = require('zod')

/**
 * Schema for Campaign Initialization (Admin endpoint)
 * Used to validate admin requests to initialize a seckill campaign
 */
const CampaignInitSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
  stock: z.number().int().positive('stock must be a positive integer'),
  price: z.number().positive('price must be a positive number'),
  startTime: z.string().datetime({ message: 'startTime must be a valid ISO datetime' }),
  endTime: z.string().datetime({ message: 'endTime must be a valid ISO datetime' }),
}).refine(
  (data) => new Date(data.endTime) > new Date(data.startTime),
  { message: 'endTime must be after startTime', path: ['endTime'] }
)

/**
 * Schema for Buy Request (Purchase endpoint)
 * Used to validate user purchase requests
 */
const BuyRequestSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
})

/**
 * Schema for Release Event (Compensation from Order Service)
 * Used to validate order.seckill.release events
 */
const ReleaseEventSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  userId: z.string().min(1, 'userId is required'),
  productId: z.string().min(1, 'productId is required'),
  reason: z.string().optional(),
}).passthrough()

/**
 * Schema for seckill.order.won event (Published on successful purchase)
 */
const SeckillOrderWonSchema = z.object({
  userId: z.string().min(1),
  productId: z.string().min(1),
  price: z.number().positive(),
  quantity: z.number().int().positive().default(1),
  timestamp: z.number().int(),
  metadata: z.object({
    campaignId: z.string().optional(),
    source: z.literal('seckill'),
  }),
})

/**
 * Schema for seckill.released event (Published on successful slot release)
 */
const SeckillReleasedSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1),
  productId: z.string().min(1),
})

module.exports = {
  CampaignInitSchema,
  BuyRequestSchema,
  ReleaseEventSchema,
  SeckillOrderWonSchema,
  SeckillReleasedSchema,
}
