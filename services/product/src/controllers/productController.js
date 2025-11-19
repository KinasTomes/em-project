const Product = require('../models/product')
// const messageBroker = require("../utils/messageBroker");
const fetch =
	// dynamic import to support CJS
	(...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))
const config = require('../config')

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

			try {
				console.log(
					`[Product Controller] Calling Inventory create for product ${product._id} with available=${available}`
				)
				console.log(
					`[Product Controller] Token: ${req.headers.authorization?.substring(
						0,
						20
					)}...`
				)
				const invBody = {
					productId: product._id.toString(),
					available,
				}
				console.log(
					`[Product Controller] Inventory create payload: ${JSON.stringify(
						invBody
					)}`
				)
				console.log(
					`[Product Controller] Forwarding Authorization header to Inventory: ${
						req.headers.authorization || 'missing'
					}`
				)

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

				if (!invRes.ok) {
					console.error(
						`[Product Controller] Inventory create failed: status=${invRes.status} body=${invPayloadText}`
					)
					// Rollback product if inventory creation fails to keep consistency
					await Product.findByIdAndDelete(product._id)
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
						console.warn(
							`[Product Controller] Inventory create returned non-JSON payload: ${invPayloadText}`
						)
					}
				}

				if (!inventoryPayload) {
					console.warn(
						`[Product Controller] Inventory create response missing body for product ${product._id}`
					)
				}

				const recordedAvailable = Number(inventoryPayload?.available)
				if (
					Number.isFinite(available) &&
					available > 0 &&
					inventoryPayload &&
					recordedAvailable !== available
				) {
					console.error(
						`[Product Controller] Inventory create mismatch for product ${product._id}: expected available ${available} but inventory reported ${recordedAvailable}`
					)
					await Product.findByIdAndDelete(product._id)
					return res.status(502).json({
						message: 'Inventory did not persist expected availability',
						inventoryStatus: invRes.status,
						inventoryResponse: inventoryPayload,
					})
				}
			} catch (err) {
				console.error(
					`[Product Controller] Error calling Inventory API: ${err.message}`
				)
				// Rollback product on network error
				await Product.findByIdAndDelete(product._id)
				return res
					.status(502)
					.json({ message: 'Inventory service unavailable' })
			}

			res.status(201).json(product)
		} catch (error) {
			console.error(error)
			res.status(500).json({ message: 'Server error' })
		}
	}

	async getProducts(req, res, next) {
		try {
			const token = req.headers.authorization
			if (!token) {
				return res.status(401).json({ message: 'Unauthorized' })
			}
			const products = await Product.find({})

			res.status(200).json(products)
		} catch (error) {
			console.error(error)
			res.status(500).json({ message: 'Server error' })
		}
	}

	async getProductById(req, res, next) {
		try {
			const token = req.headers.authorization
			if (!token) {
				return res.status(401).json({ message: 'Unauthorized' })
			}
			const { id } = req.params
			const product = await Product.findById(id)

			if (!product) {
				return res.status(404).json({ message: 'Product not found' })
			}

			res.status(200).json(product)
		} catch (error) {
			console.error(error)
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
				return res.status(404).json({ message: 'Product not found' })
			}

			res.status(200).json(product)
		} catch (error) {
			console.error(error)
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
				return res.status(404).json({ message: 'Product not found' })
			}

			// Synchronous: delete inventory record
			const INVENTORY_BASE =
				process.env.INVENTORY_URL || 'http://localhost:3005'
			try {
				console.log(
					`[Product Controller] Calling Inventory delete for product ${id}`
				)
				const invDel = await fetch(`${INVENTORY_BASE}/api/inventory/${id}`, {
					method: 'DELETE',
					headers: { Authorization: token },
				})
				if (!(invDel.status === 204 || invDel.status === 404)) {
					console.warn(
						`[Product Controller] Inventory delete unexpected status=${invDel.status}`
					)
				}
			} catch (err) {
				console.warn(
					`[Product Controller] Inventory delete failed (non-fatal): ${err.message}`
				)
				// choose not to rollback product deletion here; log for ops
			}

			res.status(204).send()
		} catch (error) {
			console.error(error)
			res.status(500).json({ message: 'Server error' })
		}
	}
}

module.exports = ProductController
