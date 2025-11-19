const { z } = require('zod')

function resolveAmount(data = {}) {
	if (typeof data.totalPrice === 'number') return data.totalPrice
	if (typeof data.totalAmount === 'number') return data.totalAmount
	if (typeof data.amount === 'number') return data.amount

	if (Array.isArray(data.products) && data.products.length > 0) {
		return data.products.reduce((total, product) => {
			const price = Number(product.price || 0)
			const quantity = Number(product.quantity || 0)
			return total + price * quantity
		}, 0)
	}

	return null
}

function normalizePayload(message) {
	if (message?.data) {
		const data = message.data
		return {
			orderId: data.orderId,
			amount: resolveAmount(data),
			currency: data.currency || message.currency || 'USD',
			products:
				data.products ||
				(data.productId
					? [
							{
								productId: data.productId,
								quantity: data.quantity ?? 1,
								price: data.price,
							},
					  ]
					: []),
			rawType: message.type || null,
		}
	}

	return {
		orderId: message.orderId,
		amount: resolveAmount(message),
		currency: message.currency || 'USD',
		products: message.productId
			? [
					{
						productId: message.productId,
						quantity: message.quantity ?? 1,
						price: message.price,
					},
			  ]
			: [],
		rawType: message.type || null,
	}
}

const StockReservedEventSchema = z
	.union([
		z
			.object({
				type: z.string().optional(),
				data: z
					.object({
						orderId: z.string().min(1, 'orderId is required'),
						totalPrice: z.number().nonnegative().optional(),
						totalAmount: z.number().nonnegative().optional(),
						amount: z.number().nonnegative().optional(),
						currency: z.string().min(1).optional(),
						reservedAt: z.string().optional(),
						userId: z.string().optional(),
						products: z
							.array(
								z.object({
									productId: z.string().min(1),
									quantity: z.number().int().positive().optional(),
									price: z.number().nonnegative().optional(),
								})
							)
							.optional(),
					})
					.passthrough(),
			})
			.passthrough(),
		z
			.object({
				orderId: z.string().min(1, 'orderId is required'),
				productId: z.string().optional(),
				quantity: z.number().int().positive().optional(),
				totalAmount: z.number().nonnegative().optional(),
				amount: z.number().nonnegative().optional(),
				currency: z.string().optional(),
				timestamp: z.string().optional(),
			})
			.passthrough(),
	])
	.transform(normalizePayload)

module.exports = {
	StockReservedEventSchema,
}
