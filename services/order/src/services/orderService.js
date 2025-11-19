const axios = require('axios')
const mongoose = require('mongoose')
const Order = require('../models/order')
const logger = require('@ecommerce/logger')

class OrderService {
	constructor(outboxManager) {
		this.outboxManager = outboxManager
		this.productServiceUrl =
			process.env.PRODUCT_SERVICE_URL || 'http://product:3004'
	}

	/**
	 * Fetch product details from the Product service and validate the IDs.
	 */
	async validateProducts(productIds, token) {
		try {
			const authHeader =
				token && token.startsWith('Bearer ') ? token : `Bearer ${token}`

			const response = await axios.get(
				`${this.productServiceUrl}/api/products`,
				{
					headers: { Authorization: authHeader },
					timeout: 5000,
				}
			)

			if (response.status !== 200) {
				throw new Error(`Product Service returned status ${response.status}`)
			}

			const allProducts = response.data
			const validProducts = allProducts.filter((product) =>
				productIds.includes(product._id.toString())
			)

			if (validProducts.length !== productIds.length) {
				const foundIds = validProducts.map((product) => product._id.toString())
				const missingIds = productIds.filter((id) => !foundIds.includes(id))
				throw new Error(`Products not found: ${missingIds.join(', ')}`)
			}

			return validProducts
		} catch (error) {
			logger.error(
				{ error: error.message, productIds },
				'Failed to validate products'
			)
			throw error
		}
	}

	/**
	 * Create a new order and enqueue reserve requests via the outbox.
	 */
	async createOrder(productIds, quantities = [], username, token) {
		if (!Array.isArray(productIds) || productIds.length === 0) {
			throw new Error('Product IDs are required')
		}

		const normalizedQuantities =
			Array.isArray(quantities) && quantities.length === productIds.length
				? quantities.map((quantity) => {
						const parsed = Number(quantity)
						return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
				  })
				: productIds.map(() => 1)

		const products = await this.validateProducts(productIds, token)

		const totalPrice = products.reduce((total, product, index) => {
			const price = Number(product?.price || 0)
			return (
				total +
				(Number.isFinite(price) ? price : 0) * normalizedQuantities[index]
			)
		}, 0)

		const session = await mongoose.startSession()
		session.startTransaction()

		try {
			const order = new Order({
				products: products.map((product, index) => ({
					_id: product._id,
					name: product.name,
					price: product.price,
					description: product.description,
					quantity: normalizedQuantities[index],
					reserved: false,
				})),
				user: username,
				totalPrice,
				status: 'PENDING',
			})

			await order.save({ session })
			const orderId = order._id.toString()

			if (!this.outboxManager) {
				throw new Error('OutboxManager not initialized')
			}

			const timestamp = new Date().toISOString()
			for (const product of order.products) {
				await this.outboxManager.createEvent({
					eventType: 'INVENTORY_RESERVE_REQUEST',
					payload: {
						type: 'RESERVE',
						data: {
							orderId,
							productId: product._id.toString(),
							quantity: product.quantity,
						},
						timestamp,
					},
					session,
					correlationId: orderId,
					destination: 'inventory',
				})
			}

			await session.commitTransaction()
			logger.info(
				{ orderId, username },
				'Order created via transactional outbox'
			)

			return {
				orderId,
				message: 'Order created and reservation requests queued',
				products: order.products.map((product) => ({
					id: product._id,
					name: product.name,
					price: product.price,
					quantity: product.quantity,
				})),
				totalPrice,
				status: order.status,
			}
		} catch (error) {
			await session.abortTransaction()
			logger.error(
				{ error: error.message, username },
				'Failed to create order, transaction rolled back'
			)
			throw error
		} finally {
			session.endSession()
		}
	}

	async getOrderById(orderId) {
		try {
			return await Order.findById(orderId)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'Failed to get order by id'
			)
			throw error
		}
	}
}

module.exports = OrderService
