const { z } = require('zod')

/**
 * Schema for ORDER_CONFIRMED event
 * This event is published when all inventory for an order has been reserved
 */
const OrderConfirmedEventSchema = z
	.object({
		type: z.string().optional(),
		data: z
			.object({
				orderId: z.string().min(1, 'orderId is required'),
				totalPrice: z.number().nonnegative('totalPrice must be non-negative'),
				currency: z.string().min(1).default('USD'),
				products: z
					.array(
						z.object({
							productId: z.string().min(1),
							quantity: z.number().int().positive(),
							price: z.number().nonnegative(),
						})
					)
					.optional(),
				userId: z.string().optional(),
				timestamp: z.string().optional(),
			})
			.passthrough(),
	})
	.passthrough()
	.transform((message) => {
		// Normalize payload to consistent format
		const data = message.data || message
		return {
			orderId: data.orderId,
			totalPrice: data.totalPrice,
			amount: data.totalPrice, // Alias for compatibility
			currency: data.currency || 'USD',
			products: data.products || [],
			userId: data.userId,
			timestamp: data.timestamp,
			rawType: message.type || 'ORDER_CONFIRMED',
		}
	})

module.exports = {
	OrderConfirmedEventSchema,
}

