const mongoose = require('mongoose')

const productSubSchema = new mongoose.Schema(
	{
		_id: { type: mongoose.Schema.Types.ObjectId, ref: 'products' },
		name: String,
		price: Number,
		description: String,
		quantity: { type: Number, required: true, min: 1 },
		reserved: { type: Boolean, default: false },
	},
	{ _id: false }
)

const orderSchema = new mongoose.Schema(
	{
		products: { type: [productSubSchema], required: true },
		totalPrice: { type: Number, required: true, min: 0 },
		user: { type: String },
		status: {
			type: String,
			enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'PAID'],
			default: 'PENDING',
		},
		cancellationReason: { type: String },
		// Metadata for tracking order source and references
		metadata: {
			source: { type: String, enum: ['regular', 'seckill'], default: 'regular' },
			seckillRef: { type: String }, // Reference to seckill event ID
			correlationId: { type: String, index: true }, // Correlation ID from seckill service for order tracking
		},
		createdAt: { type: Date, default: Date.now },
	},
	{ collection: 'orders' }
)

const Order = mongoose.model('Order', orderSchema)

module.exports = Order
