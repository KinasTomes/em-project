const Order = require('../models/order')
const logger = require('@ecommerce/logger')

/**
 * Repository layer for Order operations
 * Handles all database interactions
 */
class OrderRepository {
	/**
	 * Find order by ID
	 */
	async findById(orderId, session = null) {
		try {
			const query = Order.findById(orderId)
			if (session) {
				query.session(session)
			}
			return await query
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[OrderRepository] Error finding order'
			)
			throw error
		}
	}

	/**
	 * Find orders by user
	 */
	async findByUser(username, page = 1, limit = 20) {
		try {
			const skip = (page - 1) * limit
			const [items, total] = await Promise.all([
				Order.find({ user: username })
					.skip(skip)
					.limit(limit)
					.sort({ createdAt: -1 }),
				Order.countDocuments({ user: username }),
			])
			return {
				items,
				total,
				page,
				pages: Math.ceil(total / limit),
			}
		} catch (error) {
			logger.error(
				{ error: error.message, username },
				'[OrderRepository] Error finding orders by user'
			)
			throw error
		}
	}

	/**
	 * Find orders by status
	 */
	async findByStatus(status, page = 1, limit = 50) {
		try {
			const skip = (page - 1) * limit
			const [items, total] = await Promise.all([
				Order.find({ status }).skip(skip).limit(limit).sort({ createdAt: -1 }),
				Order.countDocuments({ status }),
			])
			return {
				items,
				total,
				page,
				pages: Math.ceil(total / limit),
			}
		} catch (error) {
			logger.error(
				{ error: error.message, status },
				'[OrderRepository] Error finding orders by status'
			)
			throw error
		}
	}

	/**
	 * Create new order
	 */
	async create(orderData, session = null) {
		try {
			const order = new Order(orderData)
			const options = session ? { session } : {}
			return await order.save(options)
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[OrderRepository] Error creating order'
			)
			throw error
		}
	}

	/**
	 * Update order by ID
	 */
	async updateById(orderId, updateData, session = null) {
		try {
			const options = { new: true, runValidators: true }
			if (session) {
				options.session = session
			}
			return await Order.findByIdAndUpdate(orderId, updateData, options)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[OrderRepository] Error updating order'
			)
			throw error
		}
	}

	/**
	 * Save order instance
	 */
	async save(order, session = null) {
		try {
			const options = session ? { session } : {}
			return await order.save(options)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId: order._id },
				'[OrderRepository] Error saving order'
			)
			throw error
		}
	}

	/**
	 * Update order status with validation
	 */
	async updateStatus(orderId, status, additionalData = {}, session = null) {
		try {
			const updateData = { status, ...additionalData }
			const options = { new: true, runValidators: true }
			if (session) {
				options.session = session
			}
			return await Order.findByIdAndUpdate(orderId, updateData, options)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId, status },
				'[OrderRepository] Error updating order status'
			)
			throw error
		}
	}

	/**
	 * Mark products as reserved
	 */
	async markProductsReserved(orderId, session = null) {
		try {
			const options = { new: true }
			if (session) {
				options.session = session
			}
			return await Order.findByIdAndUpdate(
				orderId,
				{ $set: { 'products.$[].reserved': true } },
				options
			)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[OrderRepository] Error marking products reserved'
			)
			throw error
		}
	}

	/**
	 * Get all orders with pagination
	 */
	async findAll(page = 1, limit = 50) {
		try {
			const skip = (page - 1) * limit
			const [items, total] = await Promise.all([
				Order.find().skip(skip).limit(limit).sort({ createdAt: -1 }),
				Order.countDocuments(),
			])
			return {
				items,
				total,
				page,
				pages: Math.ceil(total / limit),
			}
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[OrderRepository] Error finding all orders'
			)
			throw error
		}
	}

	/**
	 * Delete order by ID
	 */
	async deleteById(orderId) {
		try {
			return await Order.findByIdAndDelete(orderId)
		} catch (error) {
			logger.error(
				{ error: error.message, orderId },
				'[OrderRepository] Error deleting order'
			)
			throw error
		}
	}

	/**
	 * Get order statistics
	 */
	async getStatistics(startDate, endDate) {
		try {
			const matchStage = {
				createdAt: {
					$gte: startDate || new Date(0),
					$lte: endDate || new Date(),
				},
			}

			const stats = await Order.aggregate([
				{ $match: matchStage },
				{
					$group: {
						_id: '$status',
						count: { $sum: 1 },
						totalAmount: { $sum: '$totalPrice' },
					},
				},
			])

			return stats.reduce((acc, stat) => {
				acc[stat._id] = {
					count: stat.count,
					totalAmount: stat.totalAmount,
				}
				return acc
			}, {})
		} catch (error) {
			logger.error(
				{ error: error.message },
				'[OrderRepository] Error getting statistics'
			)
			throw error
		}
	}
}

module.exports = new OrderRepository()
