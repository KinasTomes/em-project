const Product = require('../models/product')
const logger = require('@ecommerce/logger')
const {
	recordProductOperation,
	startSearchTimer,
	recordInventorySync,
	startInventorySyncTimer,
	updateProductCounts,
	recordCacheHit,
	recordCacheMiss,
} = require('../metrics')
// const messageBroker = require("../utils/messageBroker");
const fetch =
	// dynamic import to support CJS
	(...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))
const config = require('../config')
const cacheService = require('../services/cacheService')

/**
 * Class to hold the API implementation for the product services
 */
class ProductController {
	constructor() {
		this.getProductById = this.getProductById.bind(this)
		this.updateProduct = this.updateProduct.bind(this)
		this.deleteProduct = this.deleteProduct.bind(this)
	}

	async createProduct(req, res, next) {
		try {
			const token = req.headers.authorization
			if (!token) {
				return res.status(401).json({ message: 'Unauthorized' })
			}
			const product = new Product(req.body)

			const validationError = product.validateSync()
			if (validationError) {
				recordProductOperation('create', 'failed')
				return res.status(400).json({ message: validationError.message })
			}

			await product.save({ timeout: 30000 })

			// Synchronous integration: call Inventory API to create inventory
			// Prefer req.body.available (fallback: initialStock) and sanitize
			const rawAvailable =
				req.body && typeof req.body.available !== 'undefined'
					? req.body.available
					: req.body && typeof req.body.initialStock !== 'undefined'
					? req.body.initialStock
					: undefined
			const parsedAvail = Number(rawAvailable)
			const available =
				Number.isFinite(parsedAvail) && parsedAvail >= 0
					? Math.floor(parsedAvail)
					: 0

			// Build Inventory service base URL
			const INVENTORY_BASE =
				process.env.INVENTORY_URL || 'http://localhost:3005'
			const inventoryCreateUrl = `${INVENTORY_BASE}/api/inventory`

			// Start inventory sync timer
			const endInventoryTimer = startInventorySyncTimer('create')

			try {
				logger.debug(
					{ productId: product._id, available },
					'Calling Inventory create'
				)
				const invBody = {
					productId: product._id.toString(),
					available,
				}

				const invRes = await fetch(inventoryCreateUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						// forward auth for consistency if inventory protects the endpoint
						Authorization: req.headers.authorization || '',
					},
					body: JSON.stringify(invBody),
				})

				const invPayloadText = await invRes.text()
				endInventoryTimer()

				if (!invRes.ok) {
					logger.error(
						{ status: invRes.status, body: invPayloadText },
						'Inventory create failed'
					)
					recordInventorySync('create', 'failed')
					// Rollback product if inventory creation fails to keep consistency
					await Product.findByIdAndDelete(product._id)
					recordProductOperation('create', 'failed')
					return res.status(502).json({
						message: 'Failed to initialize inventory for product',
						inventoryStatus: invRes.status,
					})
				}

				let inventoryPayload = null
				if (invPayloadText) {
					try {
						inventoryPayload = JSON.parse(invPayloadText)
					} catch (err) {
						logger.warn(
							{ payload: invPayloadText },
							'Inventory create returned non-JSON payload'
						)
					}
				}

				if (!inventoryPayload) {
					logger.warn(
						{ productId: product._id },
						'Inventory create response missing body'
					)
				}

				const recordedAvailable = Number(inventoryPayload?.available)
				if (
					Number.isFinite(available) &&
					available > 0 &&
					inventoryPayload &&
					recordedAvailable !== available
				) {
					logger.error(
						{ productId: product._id, expected: available, actual: recordedAvailable },
						'Inventory create mismatch'
					)
					recordInventorySync('create', 'failed')
					await Product.findByIdAndDelete(product._id)
					recordProductOperation('create', 'failed')
					return res.status(502).json({
						message: 'Inventory did not persist expected availability',
						inventoryStatus: invRes.status,
						inventoryResponse: inventoryPayload,
					})
				}

				recordInventorySync('create', 'success')
			} catch (err) {
				endInventoryTimer()
				logger.error(
					{ error: err.message },
					'Error calling Inventory API'
				)
				recordInventorySync('create', 'failed')
				// Rollback product on network error
				await Product.findByIdAndDelete(product._id)
				recordProductOperation('create', 'failed')
				return res
					.status(502)
					.json({ message: 'Inventory service unavailable' })
			}

			// Record successful product creation and update counts
			recordProductOperation('create', 'success')
			updateProductCounts(Product)

			// Invalidate cache (new product added)
			cacheService.invalidate().catch(err => {
				logger.warn({ error: err.message }, 'Failed to invalidate cache after create')
			})

			res.status(201).json(product)
		} catch (error) {
			logger.error({ error: error.message }, 'Server error in createProduct')
			recordProductOperation('create', 'failed')
			res.status(500).json({ message: 'Server error' })
		}
	}

	async getProducts(req, res, next) {
		const endTimer = startSearchTimer('list_all')
		try {
			const token = req.headers.authorization
			if (!token) {
				endTimer()
				return res.status(401).json({ message: 'Unauthorized' })
			}

			// Try cache first
			const cachedProducts = await cacheService.getAllProducts()
			if (cachedProducts) {
				endTimer()
				recordCacheHit('list_all')
				recordProductOperation('read', 'success')
				return res.status(200).json(cachedProducts)
			}

			// Cache miss - fetch from DB
			recordCacheMiss('list_all')
			const products = await Product.find({})
			endTimer()

			// Store in cache (async, don't block response)
			cacheService.setAllProducts(products).catch(err => {
				logger.warn({ error: err.message }, 'Failed to cache products')
			})

			recordProductOperation('read', 'success')
			res.status(200).json(products)
		} catch (error) {
			endTimer()
			logger.error({ error: error.message }, 'Server error in getProducts')
			recordProductOperation('read', 'failed')
			res.status(500).json({ message: 'Server error' })
		}
	}

	async getProductById(req, res, next) {
		const endTimer = startSearchTimer('by_id')
		try {
			const token = req.headers.authorization
			if (!token) {
				endTimer()
				return res.status(401).json({ message: 'Unauthorized' })
			}
			const { id } = req.params

			// Try cache first
			const cachedProduct = await cacheService.getProduct(id)
			if (cachedProduct) {
				endTimer()
				recordCacheHit('by_id')
				recordProductOperation('read', 'success')
				return res.status(200).json(cachedProduct)
			}

			// Cache miss - fetch from DB
			recordCacheMiss('by_id')
			const product = await Product.findById(id)
			endTimer()

			if (!product) {
				recordProductOperation('read', 'not_found')
				return res.status(404).json({ message: 'Product not found' })
			}

			// Store in cache (async, don't block response)
			cacheService.setProduct(id, product).catch(err => {
				logger.warn({ error: err.message, productId: id }, 'Failed to cache product')
			})

			recordProductOperation('read', 'success')
			res.status(200).json(product)
		} catch (error) {
			endTimer()
			logger.error({ error: error.message }, 'Server error in getProductById')
			recordProductOperation('read', 'failed')
			res.status(500).json({ message: 'Server error' })
		}
	}

	async updateProduct(req, res, next) {
		try {
			const token = req.headers.authorization
			if (!token) {
				return res.status(401).json({ message: 'Unauthorized' })
			}
			const { id } = req.params
			const product = await Product.findByIdAndUpdate(id, req.body, {
				new: true,
				runValidators: true,
			})

			if (!product) {
				recordProductOperation('update', 'not_found')
				return res.status(404).json({ message: 'Product not found' })
			}

			// Invalidate cache (product updated)
			cacheService.invalidate(id).catch(err => {
				logger.warn({ error: err.message, productId: id }, 'Failed to invalidate cache after update')
			})

			recordProductOperation('update', 'success')
			res.status(200).json(product)
		} catch (error) {
			logger.error({ error: error.message }, 'Server error in updateProduct')
			recordProductOperation('update', 'failed')
			res.status(500).json({ message: 'Server error' })
		}
	}

	async deleteProduct(req, res, next) {
		try {
			const token = req.headers.authorization
			if (!token) {
				return res.status(401).json({ message: 'Unauthorized' })
			}
			const { id } = req.params
			const product = await Product.findByIdAndDelete(id)

			if (!product) {
				recordProductOperation('delete', 'not_found')
				return res.status(404).json({ message: 'Product not found' })
			}

			// Synchronous: delete inventory record
			const INVENTORY_BASE =
				process.env.INVENTORY_URL || 'http://localhost:3005'
			const endInventoryTimer = startInventorySyncTimer('delete')
			try {
				logger.debug({ productId: id }, 'Calling Inventory delete')
				const invDel = await fetch(`${INVENTORY_BASE}/api/inventory/${id}`, {
					method: 'DELETE',
					headers: { Authorization: token },
				})
				endInventoryTimer()
				if (!(invDel.status === 204 || invDel.status === 404)) {
					logger.warn(
						{ status: invDel.status },
						'Inventory delete unexpected status'
					)
					recordInventorySync('delete', 'failed')
				} else {
					recordInventorySync('delete', 'success')
				}
			} catch (err) {
				endInventoryTimer()
				logger.warn(
					{ error: err.message },
					'Inventory delete failed (non-fatal)'
				)
				recordInventorySync('delete', 'failed')
				// choose not to rollback product deletion here; log for ops
			}

			recordProductOperation('delete', 'success')
			updateProductCounts(Product)

			// Invalidate cache (product deleted)
			cacheService.invalidate(id).catch(err => {
				logger.warn({ error: err.message, productId: id }, 'Failed to invalidate cache after delete')
			})

			res.status(204).send()
		} catch (error) {
			logger.error({ error: error.message }, 'Server error in deleteProduct')
			recordProductOperation('delete', 'failed')
			res.status(500).json({ message: 'Server error' })
		}
	}
}

module.exports = ProductController
