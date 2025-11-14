const amqp = require('amqplib')
const { v4: uuidv4 } = require('uuid')
const config = require('../config')
const logger = require('@ecommerce/logger')
const inventoryService = require('../services/inventoryService')

class MessageBroker {
	constructor() {
		this.channel = null
		this.connection = null
	}

	async connect() {
		await this.connectWithRetry()
	}

	async connectWithRetry(retries = 5, delay = 5000) {
		for (let i = 1; i <= retries; i++) {
			try {
				logger.info(
					`⏳ [Inventory] Connecting to RabbitMQ... (Attempt ${i}/${retries})`
				)
				this.connection = await amqp.connect(config.rabbitMQURI)
				this.channel = await this.connection.createChannel()

				// Assert only 3 main queues
				await this.channel.assertQueue('products', { durable: true })
				await this.channel.assertQueue('orders', { durable: true })
				await this.channel.assertQueue('inventory', { durable: true })

				logger.info('✓ [Inventory] RabbitMQ connected')

				// Start consuming messages
				this.startConsuming()

				// Handle connection errors
				this.connection.on('error', (err) => {
					logger.error(`[Inventory] RabbitMQ connection error: ${err.message}`)
				})

				this.connection.on('close', () => {
					logger.warn('[Inventory] RabbitMQ connection closed. Reconnecting...')
					setTimeout(() => this.connectWithRetry(), 5000)
				})

				return
			} catch (err) {
				logger.error(
					`✗ [Inventory] Failed to connect to RabbitMQ: ${err.message}`
				)
				if (i < retries) {
					logger.info(`Retrying in ${delay / 1000} seconds...`)
					await new Promise((res) => setTimeout(res, delay))
				} else {
					logger.error(
						'✗ [Inventory] Could not connect to RabbitMQ after all retries.'
					)
				}
			}
		}
	}

	/**
	 * Start consuming messages from queues
	 */
	startConsuming() {
		// Listen for product events (PRODUCT_CREATED, PRODUCT_DELETED)
		this.consumeMessage('products', this.handleProductEvents.bind(this))

		// Listen for inventory operations (RESERVE, RELEASE, RESTOCK)
		this.consumeMessage('inventory', this.handleInventoryEvents.bind(this))
	}

	/**
	 * Handle product events based on message type
	 */
	async handleProductEvents(message) {
		try {
			const { type, data } = message

			switch (type) {
				case 'PRODUCT_CREATED':
					await this.handleProductCreated(data)
					break
				case 'PRODUCT_DELETED':
					await this.handleProductDeleted(data)
					break
				default:
					logger.warn(`[Inventory] Unknown product event type: ${type}`)
			}
		} catch (error) {
			logger.error(`[Inventory] Error handling product event: ${error.message}`)
		}
	}

	/**
	 * Handle inventory events based on message type
	 */
	async handleInventoryEvents(message) {
		try {
			const { type, data } = message

			switch (type) {
				case 'RESERVE':
					await this.handleReserveRequest(data)
					break
				case 'RELEASE':
					await this.handleReleaseRequest(data)
					break
				case 'RESTOCK':
					await this.handleRestockRequest(data)
					break
				default:
					logger.warn(`[Inventory] Unknown inventory event type: ${type}`)
			}
		} catch (error) {
			logger.error(
				`[Inventory] Error handling inventory event: ${error.message}`
			)
		}
	}

	/**
	 * Handle product created event - Initialize inventory
	 */
	async handleProductCreated(data) {
		try {
			const { productId } = data
			// Prefer 'available' (new contract), fallback to legacy 'initialStock'
			const availableRaw =
				typeof data.available !== 'undefined'
					? data.available
					: typeof data.initialStock !== 'undefined'
					? data.initialStock
					: undefined

			const availableParsed = Number(availableRaw)
			const availableNormalized =
				Number.isFinite(availableParsed) && availableParsed >= 0
					? Math.floor(availableParsed)
					: 0

			if (
				availableRaw !== undefined &&
				Number(availableRaw) !== availableNormalized
			) {
				logger.warn(
					`[Inventory] Normalized available value '${availableRaw}' for product ${productId} -> ${availableNormalized}`
				)
			}

			logger.info(
				`[Inventory] Handling PRODUCT_CREATED event for ${productId} with available ${availableNormalized}`
			)

			await inventoryService.createInventory(productId, availableNormalized)
			logger.info(
				`[Inventory] Initialized inventory for product ${productId} with available ${availableNormalized}`
			)
		} catch (error) {
			logger.error(
				`[Inventory] Error handling PRODUCT_CREATED: ${error.message}`
			)
			// Don't throw - just log error and continue
		}
	}

	/**
	 * Handle product deleted event - Clean up inventory
	 */
	async handleProductDeleted(data) {
		try {
			const { productId } = data
			logger.info(`[Inventory] Handling PRODUCT_DELETED event for ${productId}`)

			await inventoryService.deleteInventory(productId)
			logger.info(`[Inventory] Deleted inventory for product ${productId}`)
		} catch (error) {
			logger.error(
				`[Inventory] Error handling PRODUCT_DELETED: ${error.message}`
			)
		}
	}

	/**
	 * Handle inventory reserve request
	 */
	async handleReserveRequest(data) {
		try {
			const { productId, quantity, orderId } = data
			logger.info(`[Inventory] Handling RESERVE request for order ${orderId}`)

			const result = await inventoryService.reserveStock(productId, quantity)

			// Publish response back to order service (orders queue with response type)
			if (result.success) {
				await this.publishInventoryResponse('INVENTORY_RESERVED', {
					orderId,
					productId,
					quantity,
					success: true,
				})
			} else {
				await this.publishInventoryResponse('INVENTORY_RESERVE_FAILED', {
					orderId,
					productId,
					quantity,
					reason: result.message,
				})
			}
		} catch (error) {
			logger.error(
				`[Inventory] Error handling RESERVE request: ${error.message}`
			)
		}
	}

	/**
	 * Handle inventory release request
	 */
	async handleReleaseRequest(data) {
		try {
			const { productId, quantity, orderId } = data
			logger.info(`[Inventory] Handling RELEASE request for order ${orderId}`)

			await inventoryService.releaseReserved(productId, quantity)
			logger.info(
				`[Inventory] Released ${quantity} units for product ${productId}`
			)
		} catch (error) {
			logger.error(
				`[Inventory] Error handling RELEASE request: ${error.message}`
			)
		}
	}

	/**
	 * Handle inventory restock request
	 */
	async handleRestockRequest(data) {
		try {
			const { productId, quantity } = data
			logger.info(
				`[Inventory] Handling RESTOCK request for product ${productId}`
			)

			await inventoryService.restockInventory(productId, quantity)
			logger.info(
				`[Inventory] Restocked ${quantity} units for product ${productId}`
			)
		} catch (error) {
			logger.error(
				`[Inventory] Error handling RESTOCK request: ${error.message}`
			)
		}
	}

	async publishInventoryResponse(eventType, payload) {
		const orderId = payload?.orderId || null
		const message = {
			type: eventType,
			data: payload,
			timestamp: new Date().toISOString(),
		}

		await this.publishMessage('orders', message, {
			correlationId: orderId,
		})
	}

	/**
	 * Publish message to a queue
	 */
	async publishMessage(queue, message, options = {}) {
		if (!this.channel) {
			logger.error('[Inventory] No RabbitMQ channel available.')
			return
		}

		try {
			await this.channel.assertQueue(queue, { durable: true })
			const eventId = options.eventId || uuidv4()
			const correlationId = options.correlationId || null

			this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
				persistent: true,
				messageId: eventId,
				correlationId,
				timestamp: Date.now(),
				headers: {
					'x-event-type': message?.type,
				},
			})
			logger.info(`[Inventory] Published message to queue: ${queue}`)
		} catch (err) {
			logger.error(`[Inventory] Error publishing message: ${err.message}`)
		}
	}

	/**
	 * Consume messages from a queue
	 */
	async consumeMessage(queue, callback) {
		if (!this.channel) {
			logger.error('[Inventory] No RabbitMQ channel available.')
			return
		}

		try {
			await this.channel.consume(
				queue,
				async (msg) => {
					if (msg === null) {
						return
					}

					try {
						const content = msg.content.toString()
						const parsedContent = JSON.parse(content)
						await callback(parsedContent)
						this.channel.ack(msg)
					} catch (error) {
						logger.error(
							`[Inventory] Error processing message from ${queue}: ${error.message}`
						)
						// Reject and don't requeue if there's a processing error
						this.channel.reject(msg, false)
					}
				},
				{ noAck: false }
			)
			logger.info(`[Inventory] Started consuming from queue: ${queue}`)
		} catch (err) {
			logger.error(`[Inventory] Error consuming messages: ${err.message}`)
		}
	}

	/**
	 * Close connection
	 */
	async close() {
		try {
			if (this.channel) {
				await this.channel.close()
			}
			if (this.connection) {
				await this.connection.close()
			}
			logger.info('[Inventory] RabbitMQ connection closed')
		} catch (error) {
			logger.error(`[Inventory] Error closing RabbitMQ: ${error.message}`)
		}
	}
}

module.exports = new MessageBroker()
