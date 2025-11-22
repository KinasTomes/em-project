# @ecommerce/message-broker

Production-ready message broker wrapper với đầy đủ tính năng cho microservices architecture.

## ✨ Features

- ✅ **Distributed Tracing**: OpenTelemetry context propagation
- ✅ **Idempotency**: Redis-based duplicate detection
- ✅ **Schema Validation**: Zod schema validation
- ✅ **Dead Letter Queue**: Automatic DLQ handling
- ✅ **Retry Logic**: Exponential backoff for transient errors
- ✅ **Connection Management**: Auto-reconnect với retry
- ✅ **Structured Logging**: Pino với trace_id injection

## 📦 Installation

```bash
pnpm add @ecommerce/message-broker
```

## 🚀 Usage

### Basic Setup

```javascript
import { Broker } from '@ecommerce/message-broker';

const broker = new Broker();
```

### Publishing Messages

```javascript
await broker.publish('ORDER_CREATED', {
  orderId: '123',
  userId: '456',
  products: [{ productId: 'p1', quantity: 2 }]
}, {
  eventId: 'evt_abc123',           // For idempotency
  correlationId: 'req_xyz789'      // For tracing
});
```

### Consuming Messages

```javascript
import { z } from 'zod';

// Define schema
const orderCreatedSchema = z.object({
  orderId: z.string(),
  userId: z.string(),
  products: z.array(z.object({
    productId: z.string(),
    quantity: z.number()
  }))
});

// Consume with schema validation
await broker.consume('ORDER_CREATED', async (data, metadata) => {
  console.log('Order received:', data.orderId);
  console.log('Event ID:', metadata.eventId);
  console.log('Correlation ID:', metadata.correlationId);
  
  // Your business logic here
}, orderCreatedSchema);
```

## 🔧 Configuration

Set environment variables:

```bash
# RabbitMQ
RABBITMQ_URL=amqp://localhost:5672

# Redis (for idempotency)
REDIS_URL=redis://localhost:6379
```

## 📋 4-Layer Processing

Khi consume message, broker sẽ xử lý qua 4 layers:

### Layer 0: Distributed Tracing
- Extract OpenTelemetry context từ message headers
- Tạo child span để track processing

### Layer 1: Idempotency Check
- Check Redis với key `processed:{eventId}`
- Skip nếu message đã được xử lý trước đó

### Layer 2: Schema Validation
- Validate message với Zod schema
- Invalid messages → DLQ (không retry)

### Layer 3: Handler Execution
- Execute business logic
- Propagate trace context vào handler

### Layer 4: Mark as Processed
- Store `processed:{eventId}` vào Redis (TTL: 24h)
- ACK message nếu thành công

## 🔄 Error Handling

### Transient Errors (Retry)
- Connection errors (ECONNREFUSED, ETIMEDOUT)
- Timeout errors
- → Message được **requeue** để retry

### Permanent Errors (DLQ)
- Schema validation errors
- Business logic errors
- → Message được gửi vào **Dead Letter Queue**

## 📊 Dead Letter Queue

Mỗi queue tự động có DLQ:

```
ORDER_CREATED        → Main queue
ORDER_CREATED.dlq    → Dead letter queue
```

Để inspect DLQ:

```javascript
// Consume from DLQ
await broker.consume('ORDER_CREATED.dlq', async (data, metadata) => {
  console.log('Failed message:', data);
  // Manual investigation/replay
}, schema);
```

## 🎯 Best Practices

### 1. Always provide eventId
```javascript
import { v4 as uuid } from 'uuid';

await broker.publish('ORDER_CREATED', data, {
  eventId: uuid()  // Unique ID for idempotency
});
```

### 2. Use correlationId for tracing
```javascript
import { trace, context } from '@opentelemetry/api';

const span = trace.getSpan(context.active());
const correlationId = span?.spanContext().traceId;

await broker.publish('ORDER_CREATED', data, {
  eventId: uuid(),
  correlationId  // Propagate trace context
});
```

### 3. Always provide schema
```javascript
// ✅ Good
await broker.consume('ORDER_CREATED', handler, orderSchema);

// ❌ Bad (no validation)
await broker.consume('ORDER_CREATED', handler);
```

### 4. Handle errors gracefully
```javascript
await broker.consume('ORDER_CREATED', async (data) => {
  try {
    await processOrder(data);
  } catch (error) {
    // Throw transient errors for retry
    if (error.code === 'ECONNREFUSED') {
      throw error;  // Will requeue
    }
    
    // Log permanent errors (will go to DLQ)
    logger.error({ error }, 'Permanent error');
    throw error;  // Will send to DLQ
  }
}, schema);
```

## 🔐 Graceful Shutdown

```javascript
// Handle shutdown signals
process.on('SIGTERM', async () => {
  await broker.close();
  process.exit(0);
});
```

## 📈 Monitoring

### Jaeger Traces
- View distributed traces tại: http://localhost:16686
- Search by `correlationId` để track toàn bộ saga

### Logs
- All logs include `eventId`, `correlationId`, `traceId`
- Filter logs by correlation ID để debug

### Redis Keys
```bash
# Check processed events
redis-cli KEYS "processed:*"

# Check specific event
redis-cli GET "processed:evt_abc123"

# TTL
redis-cli TTL "processed:evt_abc123"
# → 86400 (24 hours)
```

## 🧪 Testing

```javascript
// Mock broker for tests
import { jest } from '@jest/globals';

const mockBroker = {
  publish: jest.fn(),
  consume: jest.fn(),
  close: jest.fn()
};
```

## 📚 Related Packages

- `@ecommerce/logger` - Structured logging với trace injection
- `@ecommerce/tracing` - OpenTelemetry setup
- `@ecommerce/config` - Configuration management

## 🐛 Troubleshooting

### Message không được consume
```bash
# Check RabbitMQ connection
docker logs rabbitmq

# Check queue
curl -u guest:guest http://localhost:15672/api/queues
```

### Duplicate messages
```bash
# Check Redis
redis-cli KEYS "processed:*"

# Clear Redis (development only!)
redis-cli FLUSHALL
```

### DLQ có messages
```bash
# View DLQ depth
curl -u guest:guest http://localhost:15672/api/queues/%2F/ORDER_CREATED.dlq

# Consume DLQ để inspect
await broker.consume('ORDER_CREATED.dlq', async (data) => {
  console.log('Failed message:', data);
});
```

## 📄 License

MIT
