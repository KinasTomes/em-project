# @ecommerce/outbox-pattern

Production-ready Transactional Outbox Pattern implementation for microservices.

## 🎯 What is Outbox Pattern?

Outbox Pattern đảm bảo **at-least-once delivery** bằng cách lưu events vào database trong cùng transaction với business logic, sau đó publish chúng lên message broker một cách bất đồng bộ.

### Problem it solves:

```javascript
// ❌ WITHOUT Outbox Pattern:
async function createOrder(data) {
  await Order.create(data);           // Step 1: Success ✅
  await broker.publish('ORDER_CREATED'); // Step 2: FAIL ❌ (RabbitMQ down)
  
  // → Order exists but no event published!
  // → Downstream services don't know about order
  // → Data inconsistency
}
```

```javascript
// ✅ WITH Outbox Pattern:
async function createOrder(data) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  await Order.create([data], { session });
  await Outbox.create([{ eventType: 'ORDER_CREATED', ... }], { session });
  
  await session.commitTransaction();
  // → Both succeed or both fail (atomicity)
  // → Outbox Processor will retry publishing until success
  // → At-least-once delivery guarantee
}
```

## ✨ Features

- ✅ **At-least-once delivery**: Events never lost
- ✅ **Atomicity**: Business logic + Event creation in same transaction
- ✅ **Automatic retry**: Exponential backoff (1s, 2s, 4s, 8s, 16s)
- ✅ **Change Streams**: Real-time event detection
- ✅ **DLQ handling**: Failed events after max retries
- ✅ **Per-service isolation**: Each service has own outbox
- ✅ **OpenTelemetry integration**: Auto-inject correlation ID
- ✅ **Statistics & monitoring**: Track pending/published/failed events
- ✅ **Manual retry**: Retry failed events via API
- ✅ **Cleanup**: Delete old published events

## 📦 Installation

```bash
pnpm add @ecommerce/outbox-pattern
```

## 🚀 Quick Start

### Option 1: Simple API (Recommended)

```javascript
import mongoose from 'mongoose';
import { OutboxManager } from '@ecommerce/outbox-pattern';

// 1. Initialize
const outbox = new OutboxManager('order');
await outbox.startProcessor();

// 2. Use in your service
async function createOrder(userId, products) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Create business entity
    const order = await Order.create([{
      userId,
      products,
      status: 'PENDING'
    }], { session });
    
    // Create outbox event (same transaction)
    await outbox.createEvent({
      eventType: 'ORDER_CREATED',
      payload: {
        orderId: order[0]._id,
        userId,
        products
      },
      session
    });
    
    await session.commitTransaction();
    
    return order[0];
    
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

// 3. Graceful shutdown
process.on('SIGTERM', async () => {
  await outbox.stopProcessor();
  await mongoose.disconnect();
  process.exit(0);
});
```

### Option 2: Manual API (More Control)

```javascript
import {
  createOutboxModel,
  createOutboxEvent,
  startOutboxProcessor
} from '@ecommerce/outbox-pattern';
import { v4 as uuid } from 'uuid';

// 1. Create model
const OrderOutbox = createOutboxModel('order');

// 2. Start processor
const processor = await startOutboxProcessor('order');

// 3. Use in transaction
const session = await mongoose.startSession();
session.startTransaction();

try {
  await Order.create([{ ... }], { session });
  
  await createOutboxEvent(
    OrderOutbox,
    'ORDER_CREATED',
    { orderId: '123' },
    uuid(), // eventId
    uuid(), // correlationId
    session
  );
  
  await session.commitTransaction();
} finally {
  session.endSession();
}

// 4. Stop processor
await processor.stop();
```

## 📊 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Service (e.g., Order Service)                 │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. API Request (POST /orders)                                   │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. MongoDB Transaction                                          │
│     - Create Order                                               │
│     - Create Outbox Event (status: PENDING)                      │
│     - Commit (atomicity guaranteed)                              │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Outbox Processor (Background)                                │
│     - Watch outbox collection (Change Streams)                   │
│     - Detect new PENDING events                                  │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Publish to RabbitMQ                                          │
│     - Use @ecommerce/message-broker                              │
│     - Retry on failure (exponential backoff)                     │
│     - Mark as PUBLISHED on success                               │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Downstream Services                                          │
│     - Consume from RabbitMQ                                      │
│     - Process with idempotency                                   │
└─────────────────────────────────────────────────────────────────┘
```

## 🔧 API Reference

### OutboxManager

High-level API for managing outbox pattern.

#### Constructor

```javascript
const outbox = new OutboxManager(serviceName, connection);
```

- `serviceName` (string): Service name (e.g., 'order', 'inventory')
- `connection` (mongoose.Connection): Optional custom connection (default: mongoose)

#### Methods

##### `createEvent(options)`

Create an outbox event in a transaction.

```javascript
await outbox.createEvent({
  eventType: 'ORDER_CREATED',
  payload: { orderId: '123' },
  session,                    // MongoDB session (required)
  eventId: 'custom-id',       // Optional
  correlationId: 'trace-id'   // Optional (auto from OTel context)
});
```

##### `startProcessor()`

Start the outbox processor (Change Streams watcher).

```javascript
await outbox.startProcessor();
```

##### `stopProcessor()`

Stop the outbox processor.

```javascript
await outbox.stopProcessor();
```

##### `getStats()`

Get outbox statistics.

```javascript
const stats = await outbox.getStats();
// { pending: 5, published: 1250, failed: 2, total: 1257 }
```

##### `retryFailed(limit)`

Manually retry failed events.

```javascript
const retriedCount = await outbox.retryFailed(10);
```

##### `queryEvents(filter, options)`

Query outbox events.

```javascript
const events = await outbox.queryEvents(
  { status: 'PENDING' },
  { limit: 10, sort: { createdAt: -1 } }
);
```

##### `getEventsByCorrelationId(correlationId)`

Get all events in a saga by correlation ID.

```javascript
const events = await outbox.getEventsByCorrelationId('trace-123');
```

##### `getPendingCount()` / `getFailedCount()`

Get counts of pending/failed events.

```javascript
const pending = await outbox.getPendingCount();
const failed = await outbox.getFailedCount();
```

##### `cleanup(daysOld)`

Delete old published events (default: 7 days).

```javascript
const deleted = await outbox.cleanup(7);
```

## 🎯 Best Practices

### 1. Always use transactions

```javascript
// ✅ Good
const session = await mongoose.startSession();
session.startTransaction();

try {
  await Model.create([data], { session });
  await outbox.createEvent({ ..., session });
  await session.commitTransaction();
} finally {
  session.endSession();
}
```

### 2. Let OutboxManager generate IDs

```javascript
// ✅ Good (auto-generated)
await outbox.createEvent({
  eventType: 'ORDER_CREATED',
  payload: data,
  session
});

// ⚠️  OK (manual IDs)
await outbox.createEvent({
  eventType: 'ORDER_CREATED',
  payload: data,
  eventId: uuid(),
  correlationId: traceId,
  session
});
```

### 3. Start processor on app startup

```javascript
// app.js
import { OutboxManager } from '@ecommerce/outbox-pattern';

const outbox = new OutboxManager('order');

async function startApp() {
  await mongoose.connect(MONGO_URI);
  await outbox.startProcessor();
  
  app.listen(3000, () => {
    console.log('Server started');
  });
}
```

### 4. Handle graceful shutdown

```javascript
process.on('SIGTERM', async () => {
  await outbox.stopProcessor();
  await mongoose.disconnect();
  process.exit(0);
});
```

### 5. Monitor outbox health

```javascript
// Health check endpoint
app.get('/health/outbox', async (req, res) => {
  const stats = await outbox.getStats();
  const pending = stats.pending;
  const failed = stats.failed;
  
  if (pending > 100 || failed > 10) {
    return res.status(500).json({
      status: 'unhealthy',
      pending,
      failed
    });
  }
  
  res.json({ status: 'healthy', ...stats });
});
```

### 6. Schedule cleanup job

```javascript
// Run daily at 2 AM
import cron from 'node-cron';

cron.schedule('0 2 * * *', async () => {
  const deleted = await outbox.cleanup(7);
  logger.info({ deleted }, 'Outbox cleanup completed');
});
```

## 📈 Monitoring

### Metrics to track

```javascript
// Custom metrics (Prometheus)
const outboxPendingGauge = new Gauge({
  name: 'outbox_pending_events',
  help: 'Number of pending outbox events'
});

const outboxFailedGauge = new Gauge({
  name: 'outbox_failed_events',
  help: 'Number of failed outbox events'
});

// Update metrics every 30s
setInterval(async () => {
  const pending = await outbox.getPendingCount();
  const failed = await outbox.getFailedCount();
  
  outboxPendingGauge.set(pending);
  outboxFailedGauge.set(failed);
}, 30000);
```

### Alerts

- ⚠️  `pending > 100` → Backlog building up
- 🚨 `failed > 10` → Investigate failures
- 🚨 `pending > 1000` → Critical, processor not keeping up

## 🐛 Troubleshooting

### Events stuck in PENDING

```javascript
// Check processor status
const stats = await outbox.getStats();
console.log(stats);

// Manually trigger retry
await outbox.retryFailed(50);
```

### Change Streams not working

MongoDB must be a **Replica Set** for Change Streams:

```bash
# Local development
docker run -d --name mongo -p 27017:27017 \
  mongo:latest --replSet rs0

# Initialize replica set
docker exec -it mongo mongosh --eval "rs.initiate()"
```

### Failed events

```javascript
// Query failed events
const failed = await outbox.queryEvents({ status: 'FAILED' });

failed.forEach(event => {
  console.log('Event:', event.eventType);
  console.log('Error:', event.error);
  console.log('Retries:', event.retries);
});

// Retry manually
await outbox.retryFailed();
```

## 🧪 Testing

```javascript
import { OutboxManager } from '@ecommerce/outbox-pattern';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

describe('Outbox Pattern', () => {
  let replSet;
  let outbox;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    
    outbox = new OutboxManager('test');
    await outbox.startProcessor();
  });

  afterAll(async () => {
    await outbox.stopProcessor();
    await mongoose.disconnect();
    await replSet.stop();
  });

  it('should create event in transaction', async () => {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    await outbox.createEvent({
      eventType: 'TEST_EVENT',
      payload: { test: true },
      session
    });
    
    await session.commitTransaction();
    session.endSession();
    
    const stats = await outbox.getStats();
    expect(stats.pending).toBeGreaterThan(0);
  });
});
```

## 📚 Related Packages

- `@ecommerce/message-broker` - RabbitMQ wrapper (used by processor)
- `@ecommerce/logger` - Structured logging
- `@ecommerce/config` - Configuration management

## 📄 License

MIT
