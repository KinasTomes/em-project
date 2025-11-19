# 📬 Message Broker Architecture - Topic Exchange & Routing Keys

## 🎯 Tổng quan

Hệ thống sử dụng **RabbitMQ Topic Exchange** với routing key pattern để tổ chức message flow giữa các microservices. Pattern này cho phép flexible routing, wildcard subscriptions, và clear message categorization.

---

## 🏗️ Architecture Components

### **Exchange Configuration**

```javascript
Exchange Name: 'ecommerce.events'
Exchange Type: 'topic'
Durable: true
Auto-delete: false
```

### **Routing Key Convention**

Format: `{service}.{entity}.{action}`

**Components:**
- `{service}`: Service name producing the event (`order`, `inventory`, `product`, `payment`)
- `{entity}`: Business entity (`order`, `product`, `inventory`, `stock`)
- `{action}`: Action performed (`created`, `confirmed`, `reserved`, `failed`)

**Examples:**
- `order.inventory.reserve` - Order service requests inventory reservation
- `inventory.order.reserved` - Inventory confirms reservation to order service
- `product.product.created` - Product service announces new product
- `payment.order.completed` - Payment service confirms payment

---

## 📊 Routing Keys Mapping

### **Order Service Events**

| Routing Key | Legacy Event Type | Description |
|-------------|-------------------|-------------|
| `order.order.created` | ORDER_CREATED | Order được tạo mới |
| `order.order.confirmed` | ORDER_CONFIRMED | Order được xác nhận (sau khi inventory reserved) |
| `order.order.cancelled` | ORDER_CANCELLED | Order bị hủy |
| `order.order.paid` | ORDER_PAID | Order đã thanh toán thành công |
| `order.inventory.reserve` | RESERVE | Yêu cầu reserve stock |
| `order.inventory.release` | RELEASE | Yêu cầu release stock (compensation) |

### **Inventory Service Events**

| Routing Key | Legacy Event Type | Description |
|-------------|-------------------|-------------|
| `inventory.order.reserved` | INVENTORY_RESERVED | Stock đã được reserve thành công |
| `inventory.order.reserve_failed` | INVENTORY_RESERVE_FAILED | Không thể reserve (out of stock) |

### **Product Service Events**

| Routing Key | Legacy Event Type | Description |
|-------------|-------------------|-------------|
| `product.product.created` | PRODUCT_CREATED | Product mới được tạo |
| `product.product.deleted` | PRODUCT_DELETED | Product bị xóa |

### **Payment Service Events**

| Routing Key | Legacy Event Type | Description |
|-------------|-------------------|-------------|
| `payment.order.completed` | PAYMENT_COMPLETED | Thanh toán thành công |
| `payment.order.failed` | PAYMENT_FAILED | Thanh toán thất bại |

---

## 🎪 Queue Bindings & Wildcard Patterns

### **Order Service Queue: `order.events`**

**Bindings:**
```javascript
[
  'order.#',              // All order events (self-published for audit)
  'inventory.order.#',    // Inventory responses (reserved, reserve_failed)
  'payment.order.#'       // Payment responses (completed, failed)
]
```

**Receives:**
- `inventory.order.reserved` → Update order status to CONFIRMED
- `inventory.order.reserve_failed` → Cancel order
- `payment.order.completed` → Update order status to PAID
- `payment.order.failed` → Trigger compensation (release inventory)

---

### **Inventory Service Queue: `inventory.events`**

**Bindings:**
```javascript
[
  'order.inventory.#',    // Reserve/release requests from orders
  'product.product.#'     // Product lifecycle events
]
```

**Receives:**
- `order.inventory.reserve` → Check stock & reserve
- `order.inventory.release` → Release reserved stock
- `product.product.created` → Create inventory record
- `product.product.deleted` → Delete inventory record

---

### **Product Service Queue: `product.events`**

**Bindings:**
```javascript
[
  'product.#'  // All product events (for audit/logging)
]
```

**Note:** Product service hiện tại không consume events, chỉ publish.

---

### **Payment Service Queue: `payment.events`**

**Bindings:**
```javascript
[
  'order.order.confirmed'  // Process payment when order confirmed
]
```

**Receives:**
- `order.order.confirmed` → Process payment

---

### **Notification Service Queue: `notification.events`**

**Bindings:**
```javascript
[
  'order.order.#',     // All order status changes
  'payment.order.#'    // All payment results
]
```

**Receives:**
- `order.order.confirmed` → Send "Order confirmed" notification
- `order.order.cancelled` → Send "Order cancelled" notification
- `order.order.paid` → Send "Payment successful" notification
- `payment.order.failed` → Send "Payment failed" notification

---

## 📦 Message Structure

### **Message Headers**

```javascript
{
  'x-correlation-id': 'uuid',      // Trace entire saga
  'x-event-id': 'uuid',            // Unique message ID (idempotency)
  'x-routing-key': 'order.inventory.reserve',  // Routing key for debugging
  'traceparent': 'W3C Trace Context',  // OpenTelemetry propagation
  'tracestate': 'vendor-specific'
}
```

### **Message Body**

```javascript
{
  type: 'RESERVE',  // Legacy event type (backward compatibility)
  data: {
    orderId: 'uuid',
    productId: 'uuid',
    quantity: 5
  },
  timestamp: '2025-11-17T10:30:00Z'
}
```

---

## 🔧 Implementation Details

### **Publishing Messages**

```javascript
const { Broker } = require('@ecommerce/message-broker');

const broker = new Broker();

// Publish with routing key
await broker.publish('order.inventory.reserve', {
  type: 'RESERVE',
  data: {
    orderId: '123',
    productId: '456',
    quantity: 2
  },
  timestamp: new Date().toISOString()
}, {
  eventId: uuidv4(),
  correlationId: orderId
});
```

### **Consuming Messages**

```javascript
// Subscribe to multiple routing keys using wildcards
await broker.consume('inventory.events', [
  'order.inventory.reserve',
  'order.inventory.release',
  'product.product.created',
  'product.product.deleted'
], async (data, metadata) => {
  const { eventId, correlationId, headers } = metadata;
  const routingKey = headers['x-routing-key'];
  
  console.log(`Received: ${routingKey}`, data);
  
  // Route to appropriate handler
  switch (data.type) {
    case 'RESERVE':
      await handleReserve(data, metadata);
      break;
    // ... other handlers
  }
});
```

---

## 🛡️ Dead Letter Queue (DLQ)

### **DLQ Configuration**

Mỗi queue có DLQ riêng với routing key:

```javascript
Queue: 'inventory.events'
DLQ: 'inventory.events.dlq'

// DLX configuration
arguments: {
  'x-dead-letter-exchange': '',
  'x-dead-letter-routing-key': 'inventory.events.dlq'
}
```

### **DLQ Routing**

Messages go to DLQ khi:
- Permanent errors (schema validation failed)
- Max retries exceeded (3 attempts)
- Consumer explicitly rejects (nack with requeue=false)

---

## 📈 Benefits of Topic Exchange

### **1. Flexible Routing**
- Consumers subscribe to patterns, not specific queues
- Wildcard support: `*` (one word), `#` (zero or more words)
- Example: `order.#` matches all order events

### **2. Clear Semantics**
- Routing key explicitly shows: source → target → action
- Easy to understand message flow from routing key alone
- Self-documenting architecture

### **3. Scalability**
- Add new consumers without changing producers
- Multiple consumers can listen to same routing pattern
- Fan-out patterns for notifications

### **4. Decoupling**
- Services don't need to know queue names
- Exchange handles routing logic
- Easy to add/remove consumers

### **5. Observability**
- Routing key in logs → trace message flow
- Metrics by routing key → monitor specific flows
- Easier debugging with semantic keys

---

## 🔄 Migration from Direct Queues

### **Old Pattern (Direct Queues)**
```javascript
// Producer
await channel.sendToQueue('inventory', message);

// Consumer
await channel.consume('inventory', handler);
```

### **New Pattern (Topic Exchange)**
```javascript
// Producer
await channel.publish('ecommerce.events', 'order.inventory.reserve', message);

// Consumer
await channel.assertQueue('inventory.events');
await channel.bindQueue('inventory.events', 'ecommerce.events', 'order.inventory.#');
await channel.consume('inventory.events', handler);
```

### **Backward Compatibility**

OutboxProcessor automatically maps old eventTypes to new routing keys:

```javascript
const routingKeyMap = {
  'RESERVE': 'order.inventory.reserve',
  'ORDER_CONFIRMED': 'order.order.confirmed',
  'PRODUCT_CREATED': 'product.product.created',
  // ... etc
};
```

---

## 📊 Monitoring & Metrics

### **Key Metrics**

```prometheus
# Messages published by routing key
rabbitmq_messages_published_total{routing_key="order.inventory.reserve"} 1234

# Messages consumed by queue and routing key
rabbitmq_messages_consumed_total{queue="inventory.events",routing_key="order.inventory.reserve"} 1230

# Queue depth
rabbitmq_queue_messages_ready{queue="inventory.events"} 4

# DLQ depth (alert on > 0)
rabbitmq_queue_messages_ready{queue="inventory.events.dlq"} 0
```

### **Tracing**

OpenTelemetry spans capture:
- `publish-{routingKey}` span for each publish
- `consume-{queue}` span for each consume
- Routing key in span attributes for filtering

---

## 🎯 Best Practices

### **1. Naming Convention**
- Always use lowercase
- Use dots (.) as separators
- Format: `{service}.{entity}.{action}`
- Keep routing keys under 255 characters

### **2. Wildcard Usage**
- Use `#` for broad subscriptions (e.g., `order.#`)
- Use `*` for specific patterns (e.g., `order.*.confirmed`)
- Avoid over-broad patterns that capture unrelated messages

### **3. Error Handling**
- Classify errors as transient vs permanent
- Transient → Requeue (network, timeout)
- Permanent → DLQ (validation, schema)
- Log routing key in all error messages

### **4. Testing**
- Test wildcard patterns match expected routing keys
- Verify DLQ configuration
- Load test with realistic routing key distribution

---

## 📚 References

- [RabbitMQ Topic Exchange Tutorial](https://www.rabbitmq.com/tutorials/tutorial-five-javascript.html)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/)
