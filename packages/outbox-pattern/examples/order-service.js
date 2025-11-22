// packages/outbox-pattern/examples/order-service.js

/**
 * Example: Order Service using Outbox Pattern
 * 
 * Demonstrates complete integration of @ecommerce/outbox-pattern
 * in a microservice with Express API.
 */

import express from 'express';
import mongoose from 'mongoose';
import { OutboxManager } from '@ecommerce/outbox-pattern';
import { v4 as uuid } from 'uuid';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Define Order Model
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const orderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  products: [{
    productId: String,
    quantity: Number,
    price: Number
  }],
  totalPrice: { type: Number, required: true },
  status: {
    type: String,
    enum: ['PENDING', 'CONFIRMED', 'CANCELLED'],
    default: 'PENDING'
  },
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. Initialize Outbox Manager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const outbox = new OutboxManager('order');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. Create Express App
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const app = express();
app.use(express.json());

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. API Endpoints
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /orders - Create new order
 */
app.post('/orders', async (req, res) => {
  const { userId, products } = req.body;
  
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 Creating order with Outbox Pattern');
    
    // Calculate total price
    const totalPrice = products.reduce((sum, p) => 
      sum + (p.price * p.quantity), 0
    );
    
    // Step 1: Create Order
    const order = await Order.create([{
      userId,
      products,
      totalPrice,
      status: 'PENDING'
    }], { session });
    
    const orderId = order[0]._id.toString();
    console.log('✓ Order created:', orderId);
    
    // Step 2: Create Outbox Event (SAME transaction)
    await outbox.createEvent({
      eventType: 'ORDER_CREATED',
      payload: {
        orderId,
        userId,
        products,
        totalPrice
      },
      session
    });
    
    console.log('✓ Outbox event created');
    
    // Step 3: Commit transaction
    await session.commitTransaction();
    console.log('✓ Transaction committed');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Return immediately (async processing)
    res.status(201).json({
      orderId,
      status: 'PENDING',
      message: 'Order created, processing asynchronously'
    });
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Transaction failed:', error.message);
    res.status(500).json({ error: 'Failed to create order' });
    
  } finally {
    session.endSession();
  }
});

/**
 * GET /orders/:id - Get order by ID
 */
app.get('/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    res.json(order);
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * GET /health/outbox - Outbox health check
 */
app.get('/health/outbox', async (req, res) => {
  try {
    const stats = await outbox.getStats();
    const pending = stats.pending;
    const failed = stats.failed;
    
    // Health thresholds
    const isHealthy = pending < 100 && failed < 10;
    
    res.status(isHealthy ? 200 : 500).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      ...stats,
      thresholds: {
        maxPending: 100,
        maxFailed: 10
      }
    });
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

/**
 * POST /admin/outbox/retry - Manually retry failed events
 */
app.post('/admin/outbox/retry', async (req, res) => {
  try {
    const { limit = 10 } = req.body;
    const retriedCount = await outbox.retryFailed(limit);
    
    res.json({
      message: 'Retry completed',
      retriedCount
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /admin/outbox/events - Query outbox events
 */
app.get('/admin/outbox/events', async (req, res) => {
  try {
    const { status, correlationId, limit = 20 } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (correlationId) filter.correlationId = correlationId;
    
    const events = await outbox.queryEvents(filter, {
      limit: parseInt(limit),
      sort: { createdAt: -1 }
    });
    
    res.json({
      count: events.length,
      events
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. Startup & Shutdown
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function startup() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Order Service with Outbox Pattern');
  console.log('═══════════════════════════════════════════════════\n');
  
  // Connect to MongoDB (must be replica set!)
  const mongoUri = process.env.MONGODB_URI || 
    'mongodb://localhost:27017/order?replicaSet=rs0';
  
  console.log('⏳ Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('✓ MongoDB connected\n');
  
  // Start Outbox Processor
  console.log('⏳ Starting Outbox Processor...');
  await outbox.startProcessor();
  console.log('✓ Outbox Processor started\n');
  
  // Start HTTP server
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    console.log(`✓ Order Service started on port ${PORT}\n`);
    console.log('API Endpoints:');
    console.log(`  POST   http://localhost:${PORT}/orders`);
    console.log(`  GET    http://localhost:${PORT}/orders/:id`);
    console.log(`  GET    http://localhost:${PORT}/health/outbox`);
    console.log(`  POST   http://localhost:${PORT}/admin/outbox/retry`);
    console.log(`  GET    http://localhost:${PORT}/admin/outbox/events\n`);
  });
}

async function shutdown() {
  console.log('\n\n⏹️  Shutting down...');
  
  // Stop outbox processor
  await outbox.stopProcessor();
  console.log('✓ Outbox Processor stopped');
  
  // Close MongoDB
  await mongoose.disconnect();
  console.log('✓ MongoDB disconnected');
  
  console.log('✓ Shutdown complete');
  process.exit(0);
}

// Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start app
startup().catch(error => {
  console.error('❌ Startup failed:', error);
  process.exit(1);
});
