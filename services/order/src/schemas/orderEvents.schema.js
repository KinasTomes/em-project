const { z } = require('zod')

/**
 * Schema for INVENTORY_RESERVED_SUCCESS event
 * Order receives this when inventory has been successfully reserved
 */
const InventoryReservedSuccessSchema = z
	.object({
		type: z.string().optional(),
		data: z
			.object({
				orderId: z.string().min(1, 'orderId is required'),
				products: z
					.array(
						z.object({
							productId: z.string().min(1, 'productId is required'),
							quantity: z.number().int().positive('quantity must be positive'),
						})
					)
					.optional(),
				timestamp: z.string().optional(),
			})
			.passthrough(),
		timestamp: z.string().optional(),
	})
	.passthrough()
	.transform((message) => {
		const data = message.data || message
		return {
			orderId: data.orderId,
			products: data.products || [],
			timestamp: data.timestamp || message.timestamp,
			rawType: message.type || 'INVENTORY_RESERVED_SUCCESS',
		}
	})

/**
 * Schema for INVENTORY_RESERVED_FAILED event
 * Order receives this when inventory reservation failed
 */
const InventoryReservedFailedSchema = z
	.object({
		type: z.string().optional(),
		data: z
			.object({
				orderId: z.string().min(1, 'orderId is required'),
				products: z
					.array(
						z.object({
							productId: z.string().min(1, 'productId is required'),
							quantity: z.number().int().positive('quantity must be positive'),
						})
					)
					.optional(),
				reason: z.string().optional(),
				timestamp: z.string().optional(),
			})
			.passthrough(),
		timestamp: z.string().optional(),
	})
	.passthrough()
	.transform((message) => {
		const data = message.data || message
		return {
			orderId: data.orderId,
			products: data.products || [],
			reason: data.reason || 'Unknown reason',
			timestamp: data.timestamp || message.timestamp,
			rawType: message.type || 'INVENTORY_RESERVED_FAILED',
		}
	})

/**
 * Schema for PAYMENT_SUCCEEDED event
 * Order receives this when payment has been successfully processed
 */
const PaymentSucceededSchema = z
	.object({
		type: z.string().optional(),
		data: z
			.object({
				orderId: z.string().min(1, 'orderId is required'),
				transactionId: z.string().optional(),
				amount: z.number().nonnegative().optional(),
				currency: z.string().optional(),
				processedAt: z.string().optional(),
			})
			.passthrough(),
		timestamp: z.string().optional(),
	})
	.passthrough()
	.transform((message) => {
		const data = message.data || message
		return {
			orderId: data.orderId,
			transactionId: data.transactionId,
			amount: data.amount,
			currency: data.currency || 'USD',
			processedAt: data.processedAt || message.timestamp,
			rawType: message.type || 'PAYMENT_SUCCEEDED',
		}
	})

/**
 * Schema for PAYMENT_FAILED event
 * Order receives this when payment has failed
 */
const PaymentFailedSchema = z
	.object({
		type: z.string().optional(),
		data: z
			.object({
				orderId: z.string().min(1, 'orderId is required'),
				reason: z.string().optional(),
				products: z
					.array(
						z.object({
							productId: z.string().min(1),
							quantity: z.number().int().positive(),
						})
					)
					.optional(),
				timestamp: z.string().optional(),
			})
			.passthrough(),
		timestamp: z.string().optional(),
	})
	.passthrough()
	.transform((message) => {
		const data = message.data || message
		return {
			orderId: data.orderId,
			reason: data.reason || 'Payment processing failed',
			products: data.products || [],
			timestamp: data.timestamp || message.timestamp,
			rawType: message.type || 'PAYMENT_FAILED',
		}
	})

module.exports = {
	InventoryReservedSuccessSchema,
	InventoryReservedFailedSchema,
	PaymentSucceededSchema,
	PaymentFailedSchema,
}
