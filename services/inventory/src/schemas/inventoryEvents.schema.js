const { z } = require('zod')

/**
 * Schema for ORDER_CREATED event
 * Inventory listens to this event to reserve stock
 */
const OrderCreatedSchema = z
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
					.min(1, 'At least one product is required'),
			})
			.passthrough(),
		timestamp: z.string().optional(),
	})
	.passthrough()
	.transform((message) => {
		// Normalize to consistent format
		const data = message.data || message
		return {
			orderId: data.orderId,
			products: data.products,
			rawType: message.type || 'ORDER_CREATED',
		}
	})

/**
 * Schema for ORDER_CANCELLED event
 * Inventory listens to this event to release reserved stock
 * 
 * Accepts two formats:
 * 1. Wrapped: { type?: string, data: { orderId, reason, ... } }
 * 2. Direct: { orderId, reason, ... }
 */
const orderCancelledDataSchema = z.object({
	orderId: z.union([z.string(), z.any()]).transform(val => String(val)), // Accept ObjectId or string
	reason: z.string().optional(),
	products: z
		.array(
			z.object({
				productId: z.string().min(1, 'productId is required'),
				quantity: z.number().int().positive('quantity must be positive'),
			})
		)
		.optional(),
}).passthrough()

const OrderCancelledSchema = z
	.union([
		// Wrapped format: { type?: string, data: { ... } }
		z.object({
			type: z.string().optional(),
			data: orderCancelledDataSchema,
			timestamp: z.string().optional(),
		}).passthrough(),
		// Direct format: { orderId, reason, ... }
		orderCancelledDataSchema,
	])
	.transform((message) => {
		// Normalize to consistent format
		const data = message.data || message
		return {
			orderId: data.orderId,
			products: data.products || [],
			reason: data.reason,
			rawType: message.type || 'ORDER_CANCELLED',
		}
	})

/**
 * Schema for PRODUCT_CREATED event
 */
const ProductCreatedSchema = z
	.object({
		type: z.string().optional(),
		data: z
			.object({
				productId: z.string().min(1, 'productId is required'),
				available: z.number().int().nonnegative().optional(),
				initialStock: z.number().int().nonnegative().optional(),
			})
			.passthrough(),
		timestamp: z.string().optional(),
	})
	.passthrough()
	.transform((message) => {
		const data = message.data || message
		// Support both 'available' and legacy 'initialStock'
		const available =
			typeof data.available !== 'undefined'
				? data.available
				: typeof data.initialStock !== 'undefined'
					? data.initialStock
					: 0

		return {
			productId: data.productId,
			available: Number.isFinite(Number(available))
				? Math.floor(Math.max(0, Number(available)))
				: 0,
			rawType: message.type || 'PRODUCT_CREATED',
		}
	})

/**
 * Schema for PRODUCT_DELETED event
 */
const ProductDeletedSchema = z
	.object({
		type: z.string().optional(),
		data: z
			.object({
				productId: z.string().min(1, 'productId is required'),
			})
			.passthrough(),
		timestamp: z.string().optional(),
	})
	.passthrough()
	.transform((message) => {
		const data = message.data || message
		return {
			productId: data.productId,
			rawType: message.type || 'PRODUCT_DELETED',
		}
	})

/**
 * Schema for PAYMENT_FAILED event (compensation)
 * 
 * Accepts two formats:
 * 1. Wrapped: { type?: string, data: { orderId, reason, products, ... } }
 * 2. Direct: { orderId, reason, products, ... }
 */
const paymentFailedDataSchema = z.object({
	orderId: z.union([z.string(), z.any()]).transform(val => String(val)), // Accept ObjectId or string
	transactionId: z.string().optional(),
	reason: z.string().optional(),
	compensation: z.boolean().optional(),
	products: z
		.array(
			z.object({
				productId: z.string().min(1),
				quantity: z.number().int().positive(),
			})
		)
		.optional(),
}).passthrough()

const PaymentFailedSchema = z
	.union([
		// Wrapped format: { type?: string, data: { ... } }
		z.object({
			type: z.string().optional(),
			data: paymentFailedDataSchema,
			timestamp: z.string().optional(),
		}).passthrough(),
		// Direct format: { orderId, reason, products, ... }
		paymentFailedDataSchema,
	])
	.transform((message) => {
		const data = message.data || message
		return {
			orderId: data.orderId,
			transactionId: data.transactionId,
			reason: data.reason || 'Payment failed',
			compensation: data.compensation || true,
			products: data.products || [],
			rawType: message.type || 'PAYMENT_FAILED',
		}
	})

module.exports = {
	OrderCreatedSchema,
	OrderCancelledSchema,
	ProductCreatedSchema,
	ProductDeletedSchema,
	PaymentFailedSchema,
}

