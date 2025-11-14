# Changelog

All notable changes to `@ecommerce/message-broker` will be documented in this file.

## [1.0.0] - 2025-11-09

### Added

- ✨ **Core Features**

  - RabbitMQ wrapper với retry logic (5 attempts, 5s delay)
  - Redis-based idempotency checking (24h TTL)
  - Zod schema validation
  - OpenTelemetry distributed tracing
  - Dead Letter Queue (DLQ) automatic handling
  - Graceful shutdown support

- 🔄 **4-Layer Message Processing**

  - Layer 0: Distributed Tracing (context extraction)
  - Layer 1: Idempotency Check (Redis)
  - Layer 2: Schema Validation (Zod)
  - Layer 3: Handler Execution
  - Layer 4: Mark as Processed (Redis + ACK)

- 🎯 **Error Handling**

  - Transient errors → Requeue for retry
  - Permanent errors → Send to DLQ
  - Schema validation errors → DLQ (no retry)
  - Connection retry với exponential backoff

- 📊 **Observability**

  - Structured logging with Pino
  - OpenTelemetry span creation
  - Trace context propagation (inject/extract)
  - correlationId tracking across services
  - Performance metrics (processing duration)

- 🔐 **Production-Ready Features**

  - Connection pooling
  - Channel error handling
  - Prefetch limit (1 message at a time)
  - Persistent messages (survive broker restart)
  - Graceful shutdown (close connections properly)

- 📚 **Documentation**
  - README.md with full API documentation
  - Basic usage example
  - Outbox Pattern example
  - Best practices guide
  - Troubleshooting section

### Technical Details

**Dependencies:**

- `amqplib`: ^0.10.9 (RabbitMQ client)
- `redis`: ^5.9.0 (Redis client)
- `zod`: ^4.1.12 (Schema validation)
- `@opentelemetry/api`: ^1.9.0 (Distributed tracing)
- `@ecommerce/logger`: workspace:\* (Structured logging)

**Environment Variables:**

- `RABBITMQ_URL`: RabbitMQ connection string (default: amqp://localhost:5672)
- `REDIS_URL`: Redis connection string (default: redis://localhost:6379)

**Queue Configuration:**

- Durable queues (survive RabbitMQ restart)
- Dead Letter Queue per queue (auto-created)
- Prefetch: 1 (process one message at a time)
- Persistent messages (deliveryMode: 2)

**Idempotency:**

- Redis key pattern: `processed:{eventId}`
- TTL: 24 hours (86400 seconds)
- Prevents duplicate processing

**Tracing:**

- OpenTelemetry context propagation
- Inject: `traceparent` header in published messages
- Extract: Create child span from received messages
- Correlation ID tracking throughout saga

### Breaking Changes

- None (initial release)

### Migration Guide

- None (initial release)

### Examples

**Basic Publish:**

```javascript
import { Broker } from '@ecommerce/message-broker'
const broker = new Broker()

await broker.publish(
	'ORDER_CREATED',
	{
		orderId: '123',
		userId: '456',
	},
	{
		eventId: 'evt_abc',
		correlationId: 'req_xyz',
	}
)
```

**Basic Consume:**

```javascript
import { z } from 'zod'

const schema = z.object({
	orderId: z.string(),
	userId: z.string(),
})

await broker.consume(
	'ORDER_CREATED',
	async (data, metadata) => {
		console.log('Order:', data.orderId)
	},
	schema
)
```

**Outbox Pattern:**

```javascript
// See examples/outbox-pattern.js for full implementation
const session = await mongoose.startSession();
session.startTransaction();

await Order.create([{ ... }], { session });
await Outbox.create([{ eventType: 'ORDER_CREATED', ... }], { session });

await session.commitTransaction();
```

### Known Issues

- None

### Contributors

- Initial implementation: @KinasTomes

---

## Future Roadmap

### [1.1.0] - Planned

- [ ] Metrics integration (Prometheus)
- [ ] Rate limiting
- [ ] Message priority queues
- [ ] Batch message processing
- [ ] Message TTL configuration

### [2.0.0] - Planned

- [ ] Multiple broker support (Kafka, NATS)
- [ ] Event versioning
- [ ] Message encryption
- [ ] Schema registry integration
- [ ] Advanced retry strategies (circuit breaker)
