const logger = require('@ecommerce/logger')

class OrderController {
	constructor(orderService) {
		this.orderService = orderService
		this.createOrder = this.createOrder.bind(this)
		this.getOrderById = this.getOrderById.bind(this)
	}

	/**
	 * POST /api/orders
	 * Create a new order
	 */
	async createOrder(req, res) {
		try {
			const token = req.headers.authorization
			if (!token) {
				return res.status(401).json({ message: 'Unauthorized' })
			}

			const { ids, quantities } = req.body

			// Validate input
			if (!ids || !Array.isArray(ids) || ids.length === 0) {
				return res.status(400).json({ message: 'Product IDs are required' })
			}

			const username = req.user.username

			// Create order via service
			const result = await this.orderService.createOrder(
				ids,
				quantities,
				username,
				token
			)

			return res.status(201).json(result)
		} catch (error) {
			logger.error(
				{ error: error.message, body: req.body },
				'Failed to create order'
			)

			if (error.message.includes('not found')) {
				return res.status(404).json({ message: error.message })
			}

			if (error.code === 'ECONNREFUSED' || error.message.includes('timeout')) {
				return res.status(503).json({ message: 'Product Service unavailable' })
			}

			return res.status(500).json({ message: 'Server error' })
		}
	}

	/**
	 * GET /api/orders/:id
	 * Return order details including status
	 */
	async getOrderById(req, res) {
		try {
			const token = req.headers.authorization
			if (!token) {
				return res.status(401).json({ message: 'Unauthorized' })
			}

			const { id } = req.params
			if (!id) return res.status(400).json({ message: 'Order id required' })

			const order = await this.orderService.getOrderById(id)
			if (!order) return res.status(404).json({ message: 'Order not found' })

			return res.status(200).json({
				orderId: order._id,
				products: order.products,
				totalPrice: order.totalPrice,
				user: order.user,
				status: order.status,
				createdAt: order.createdAt,
			})
		} catch (error) {
			logger.error({ error: error.message }, 'Failed to fetch order')
			return res.status(500).json({ message: 'Server error' })
		}
	}
}

module.exports = OrderController
