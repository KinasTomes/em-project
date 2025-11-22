# 🔄 Saga Pattern - Luồng xử lý và Event Choreography

Tài liệu này mô tả chi tiết các luồng Saga hiện có trong hệ thống E-commerce, bao gồm luồng chính (Happy Path) và các luồng bù trừ (Compensation).

---

## 📊 Tổng quan kiến trúc

Hệ thống sử dụng **Saga Pattern với Event Choreography** qua RabbitMQ, bao gồm 5 microservices:

```
┌─────────────┐
│ API Gateway │ (Port 3003)
└──────┬──────┘
       │
       ├─────────────┬─────────────┬──────────────┬────────────────┐
       ▼             ▼             ▼              ▼                ▼
┌────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌─────────┐
│  Auth  │   │  Order   │   │ Product  │   │ Inventory │   │ Payment │
│(3001)  │   │  (3002)  │   │  (3004)  │   │   (3005)  │   │ (3006)  │
└────────┘   └────┬─────┘   └──────────┘   └─────┬─────┘   └────┬────┘
                  │                               │              │
                  └───────────────┬───────────────┴──────────────┘
                                  ▼
                            ┌──────────┐
                            │ RabbitMQ │
                            └──────────┘
```

---

## 🎯 Luồng 1: Order Creation - Happy Path (Thành công)

### Mô tả
User tạo đơn hàng mới → Reserve inventory → Process payment → Order hoàn thành với trạng thái PAID.

### Bảng luồng sự kiện

| Bước | Event Type | Producer | Queue | Consumer | Action | Status Transition |
|------|-----------|----------|-------|----------|--------|-------------------|
| 1 | `POST /api/orders` | User → API Gateway | - | Order Service (HTTP) | Tạo Order với status `PENDING` | - → `PENDING` |
| 2 | `INVENTORY_RESERVE_REQUEST` | Order Service (Outbox) | `inventory` | Inventory Service | Reserve stock cho từng product | - |
| 3 | `INVENTORY_RESERVED` | Inventory Service | `orders` | Order Service | Đánh dấu product.reserved = true | `PENDING` (chờ đủ products) |
| 4 | `ORDER_CONFIRMED` | Order Service (Outbox) | `STOCK_RESERVED` | Payment Service | Gửi thông tin order đã reserve đủ stock | `PENDING` → `CONFIRMED` |
| 5 | `PAYMENT_SUCCEEDED` | Payment Service | `order-events` | Order Service | Thanh toán thành công | `CONFIRMED` → `PAID` |
| 6 | `ORDER_PAID` | Order Service (Outbox) | - | (Future: Notification/Fulfillment) | Hoàn tất đơn hàng | - |

### Chi tiết từng bước

#### **Bước 1: User tạo Order**
```javascript
// Producer: User → API Gateway → Order Service
POST /api/orders
Body: {
  "ids": ["product_1", "product_2"],
  "quantities": [2, 1]
}

// Action: OrderService.createOrder()
- Validate products qua Product Service
- Tạo Order document (status: PENDING)
- Phát INVENTORY_RESERVE_REQUEST qua Outbox cho từng product
```

#### **Bước 2-3: Inventory Reserve**
```javascript
// Producer: Order Service (Outbox → OutboxProcessor → RabbitMQ)
Event: INVENTORY_RESERVE_REQUEST
Queue: inventory
Payload: {
  type: "RESERVE",
  data: {
    orderId: "order_123",
    productId: "product_1",
    quantity: 2
  }
}

// Consumer: Inventory Service
Action: inventoryService.reserveStock()
- Check available stock
- Atomic update: available -= quantity, reserved += quantity

// Producer: Inventory Service → RabbitMQ
Event: INVENTORY_RESERVED (nếu thành công)
Queue: orders
Payload: {
  type: "INVENTORY_RESERVED",
  data: {
    orderId: "order_123",
    productId: "product_1",
    quantity: 2
  }
}

// Consumer: Order Service._handleInventoryReserved()
Action:
- Set product.reserved = true
- Nếu ALL products reserved → emit ORDER_CONFIRMED
```

#### **Bước 4: Order Confirmed (Trigger Payment)**
```javascript
// Producer: Order Service (Outbox)
Event: ORDER_CONFIRMED
Queue: STOCK_RESERVED
Payload: {
  orderId: "order_123",
  totalPrice: 299.99,
  currency: "USD",
  products: [
    { productId: "product_1", quantity: 2, price: 99.99 },
    { productId: "product_2", quantity: 1, price: 100.01 }
  ]
}

// Consumer: Payment Service (stockReservedConsumer)
Action: paymentProcessor.process()
- Mock payment logic (success rate 0.9)
- Generate transactionId
```

#### **Bước 5-6: Payment Success**
```javascript
// Producer: Payment Service → RabbitMQ
Event: PAYMENT_SUCCEEDED
Queue: order-events
Payload: {
  type: "PAYMENT_SUCCEEDED",
  data: {
    orderId: "order_123",
    transactionId: "txn_abc",
    amount: 299.99,
    currency: "USD"
  }
}

// Consumer: Order Service._handlePaymentSucceeded()
Action:
- Validate order status = CONFIRMED (FSM check)
- Update order.status = PAID
- Emit ORDER_PAID event (Outbox)
```

---

## ⚠️ Luồng 2: Inventory Reserve Failed (Bù trừ cấp 1)

### Mô tả
Inventory không đủ stock để reserve → Cancel order ngay lập tức.

### Bảng luồng sự kiện

| Bước | Event Type | Producer | Queue | Consumer | Action | Status Transition |
|------|-----------|----------|-------|----------|--------|-------------------|
| 1-2 | *(Same as Happy Path)* | - | - | - | Tạo Order, gửi reserve request | - → `PENDING` |
| 3 | `INVENTORY_RESERVE_FAILED` | Inventory Service | `orders` | Order Service | Stock không đủ | - |
| 4 | `ORDER_CANCELLED` | Order Service (Outbox) | - | (Future: Notification) | Hủy order | `PENDING` → `CANCELLED` |

### Chi tiết

#### **Bước 3: Inventory Insufficient**
```javascript
// Producer: Inventory Service
Event: INVENTORY_RESERVE_FAILED
Queue: orders
Payload: {
  type: "INVENTORY_RESERVE_FAILED",
  data: {
    orderId: "order_123",
    productId: "product_1",
    reason: "Insufficient stock. Available: 0, Requested: 2"
  }
}

// Consumer: Order Service._handleInventoryReserveFailed()
Action:
- Validate FSM transition: PENDING → CANCELLED
- Set order.status = CANCELLED
- Set order.cancellationReason
- Emit ORDER_CANCELLED event (Outbox)
```

**⚠️ Lưu ý:** Không cần release inventory vì stock chưa được reserve.

---

## 💳 Luồng 3: Payment Failed (Bù trừ cấp 2 - Compensation)

### Mô tả
Stock đã được reserve nhưng thanh toán thất bại → Phải release inventory về lại (compensation).

### Bảng luồng sự kiện

| Bước | Event Type | Producer | Queue | Consumer | Action | Status Transition |
|------|-----------|----------|-------|----------|--------|-------------------|
| 1-4 | *(Same as Happy Path)* | - | - | - | Order confirmed, stock reserved | - → `CONFIRMED` |
| 5 | `PAYMENT_FAILED` | Payment Service | `order-events` | Order Service | Payment gateway declined | - |
| 6a | `INVENTORY_RELEASE_REQUEST` | Order Service (Outbox) | `inventory` | Inventory Service | **Compensation**: Release stock | - |
| 6b | `ORDER_CANCELLED` | Order Service (Outbox) | - | (Future: Notification) | Hủy order | `CONFIRMED` → `CANCELLED` |
| 7 | `INVENTORY_RELEASED` | Inventory Service | `orders` | Order Service | Stock đã được trả lại | - |

### Chi tiết

#### **Bước 5: Payment Failed**
```javascript
// Producer: Payment Service
Event: PAYMENT_FAILED
Queue: order-events
Payload: {
  type: "PAYMENT_FAILED",
  data: {
    orderId: "order_123",
    transactionId: "txn_failed",
    amount: 299.99,
    currency: "USD",
    reason: "Mock gateway declined the payment"
  }
}

// Consumer: Order Service._handlePaymentFailed()
Action:
- Validate order.status = CONFIRMED (FSM check)
- Update order.status = CANCELLED
- Loop qua tất cả reserved products
- Emit INVENTORY_RELEASE_REQUEST cho từng product (Compensation)
- Emit ORDER_CANCELLED event
```

#### **Bước 6a: Compensation - Release Inventory**
```javascript
// Producer: Order Service (Outbox)
Event: INVENTORY_RELEASE_REQUEST
Queue: inventory
Payload: {
  type: "RELEASE",
  data: {
    orderId: "order_123",
    productId: "product_1",
    quantity: 2,
    reason: "PAYMENT_FAILED"
  }
}

// Consumer: Inventory Service (handleReleaseRequest)
Action: inventoryService.releaseReserved()
- Atomic update: available += quantity, reserved -= quantity

// Producer: Inventory Service → RabbitMQ
Event: INVENTORY_RELEASED
Queue: orders
Payload: {
  type: "INVENTORY_RELEASED",
  data: {
    orderId: "order_123",
    productId: "product_1",
    quantity: 2
  }
}
```

---

## 🔄 Luồng 4: Payment Failed - Inventory Auto Compensation (Alternative)

### Mô tả
Payment Service có thể publish trực tiếp PAYMENT_FAILED event lên `inventory-events` queue để Inventory tự động release stock (alternative approach - hiện chưa implement).

### Bảng luồng sự kiện

| Bước | Event Type | Producer | Queue | Consumer | Action | Ghi chú |
|------|-----------|----------|-------|----------|--------|---------|
| 1-4 | *(Same as Happy Path)* | - | - | - | - | - |
| 5a | `PAYMENT_FAILED` | Payment Service | `order-events` | Order Service | Cancel order | `CONFIRMED` → `CANCELLED` |
| 5b | `PAYMENT_FAILED` | Payment Service | `inventory-events` | Inventory Service | **Auto compensation** | ⚠️ Hiện code có handler nhưng chưa được Payment gọi |

### Chi tiết

```javascript
// Producer: Payment Service (publishFailure)
// Publish to BOTH queues simultaneously
await Promise.all([
  broker.publish('order-events', failurePayload, { ... }),
  broker.publish('inventory-events', {
    ...failurePayload,
    data: {
      ...failurePayload.data,
      compensation: true,
      products: payload.products  // Forward products for auto-release
    }
  }, { ... })
])

// Consumer: Inventory Service (handlePaymentFailed)
// Auto-release stock for all products in the order
for (const product of message.products) {
  await inventoryService.releaseReserved(product.productId, product.quantity)
}
```

**⚠️ Lưu ý:** Approach này hiện chưa active vì:
- Payment Service chỉ publish lên `order-events` queue
- Inventory có handler `handlePaymentFailed` nhưng không được kích hoạt
- Cần thống nhất approach: Order orchestrate compensation vs Inventory auto-compensation

---

## 📋 Bảng tổng hợp Event Types

| Event Type | Producer | Consumer | Queue | Purpose |
|------------|----------|----------|-------|---------|
| `INVENTORY_RESERVE_REQUEST` | Order Service (Outbox) | Inventory Service | `inventory` | Yêu cầu reserve stock |
| `INVENTORY_RESERVED` | Inventory Service | Order Service | `orders` | Xác nhận reserved thành công |
| `INVENTORY_RESERVE_FAILED` | Inventory Service | Order Service | `orders` | Thông báo reserve thất bại |
| `ORDER_CONFIRMED` | Order Service (Outbox) | Payment Service | `STOCK_RESERVED` | Trigger payment (all stock reserved) |
| `PAYMENT_SUCCEEDED` | Payment Service | Order Service | `order-events` | Thanh toán thành công |
| `PAYMENT_FAILED` | Payment Service | Order Service | `order-events` | Thanh toán thất bại |
| `INVENTORY_RELEASE_REQUEST` | Order Service (Outbox) | Inventory Service | `inventory` | **Compensation**: Yêu cầu release stock |
| `INVENTORY_RELEASED` | Inventory Service | Order Service | `orders` | Xác nhận released thành công |
| `ORDER_CANCELLED` | Order Service (Outbox) | (Future: Notification) | - | Đơn hàng bị hủy |
| `ORDER_PAID` | Order Service (Outbox) | (Future: Fulfillment) | - | Đơn hàng đã thanh toán |
| `PRODUCT_CREATED` | Product Service (Future) | Inventory Service | `inventory-events` | Tạo inventory cho product mới |
| `PRODUCT_DELETED` | Product Service (Future) | Inventory Service | `inventory-events` | Xóa inventory khi product bị xóa |

---

## 🏗️ Architecture Patterns

### 1. Transactional Outbox Pattern

**Dùng bởi:** Order Service

**Mục đích:** Đảm bảo atomicity giữa DB update và event publishing.

```javascript
// Order Service
const session = await mongoose.startSession()
await session.withTransaction(async () => {
  // 1. Update database
  order.status = 'CANCELLED'
  await order.save({ session })
  
  // 2. Queue event trong cùng transaction
  await outboxManager.createEvent({
    eventType: 'ORDER_CANCELLED',
    payload: { orderId, reason },
    session,  // ← Same transaction
    correlationId
  })
})

// OutboxProcessor (Change Streams)
// Watch outbox collection → Publish to RabbitMQ → Mark as processed
```

**Không dùng bởi:** Inventory Service, Payment Service (stateless)

---

### 2. Event Choreography

**Principle:** Mỗi service tự quyết định phản ứng với event, không có central orchestrator.

```
Order creates → Inventory reacts → Order reacts → Payment reacts → Order reacts
```

---

### 3. Idempotency

**Layer 1: Broker-level (Redis)**
```javascript
// packages/message-broker/index.js
const processedKey = `processed:${eventId}`
const alreadyProcessed = await redisClient.get(processedKey)

if (alreadyProcessed) {
  logger.warn('Duplicate message detected, skipping')
  channel.ack(msg)
  return
}

await handler(data, metadata)
await redisClient.set(processedKey, '1', { EX: 86400 })  // 24h TTL
```

**Layer 2: Service-level**
- Order Service: Check order status với FSM trước khi transition
- Inventory Service: Atomic operations với MongoDB `$inc`

---

### 4. Finite State Machine (FSM)

**Dùng bởi:** Order Service

```javascript
// services/order/src/services/orderStateMachine.js
const fsm = createOrderStateMachine('PENDING')

// Validate transitions
fsm.confirm()  // PENDING → CONFIRMED ✓
fsm.pay()      // CONFIRMED → PAID ✓
fsm.cancel()   // PENDING/CONFIRMED → CANCELLED ✓

// Invalid transitions throw error
fsm.pay()      // PENDING → PAID ✗ (throws error)
```

---

## 🎯 Compensation Strategies

### Strategy 1: Orchestrated Compensation (Hiện tại)

Order Service orchestrate tất cả compensation logic.

**Ưu điểm:**
- ✅ Centralized compensation logic
- ✅ Order có full context về products cần release
- ✅ Easy to debug và trace

**Nhược điểm:**
- ❌ Order Service phải biết compensation logic của Inventory
- ❌ Tight coupling giữa services

---

### Strategy 2: Auto Compensation (Alternative - chưa active)

Mỗi service tự compensation khi nhận failure event.

**Ưu điểm:**
- ✅ Loose coupling
- ✅ Inventory encapsulate compensation logic

**Nhược điểm:**
- ❌ Payment phải forward product list
- ❌ Harder to debug distributed compensation

---

## 📊 Status Flow Diagram

```
User creates order
       ↓
   [PENDING]
       ├─→ INVENTORY_RESERVED (all products) → [CONFIRMED]
       │                                            ├─→ PAYMENT_SUCCEEDED → [PAID] ✓
       │                                            └─→ PAYMENT_FAILED → [CANCELLED] ⚠️
       │                                                  ↓
       │                                            (Compensation: Release inventory)
       │
       └─→ INVENTORY_RESERVE_FAILED → [CANCELLED] ✗
```

---

## 🔍 Monitoring & Observability

### Correlation ID

Mỗi saga flow có duy nhất 1 `correlationId` (thường là `orderId`) để trace toàn bộ luồng qua các services.

```javascript
// All events trong cùng saga có cùng correlationId
INVENTORY_RESERVE_REQUEST  correlationId: order_123
INVENTORY_RESERVED         correlationId: order_123
ORDER_CONFIRMED            correlationId: order_123
PAYMENT_SUCCEEDED          correlationId: order_123
ORDER_PAID                 correlationId: order_123
```

### OpenTelemetry Tracing

```javascript
// Trace context được inject vào RabbitMQ headers
propagation.inject(activeContext, messageHeaders)

// Consumer extract context để maintain trace chain
const extractedContext = propagation.extract(context.active(), headers)
const span = tracer.startSpan('consume-orders', {}, extractedContext)
```

### Dead Letter Queue (DLQ)

Events failed schema validation hoặc exceed retry limit → `{queue}.dlq`

---

## 🚀 Future Enhancements

### 1. Saga Timeout & Compensation

```javascript
// Order Service
// Nếu không nhận PAYMENT_SUCCEEDED/FAILED sau 5 phút
setTimeout(() => {
  if (order.status === 'CONFIRMED') {
    // Auto-cancel và release inventory
    compensateOrder(orderId)
  }
}, 5 * 60 * 1000)
```

### 2. Partial Success Handling

```javascript
// Nếu 1 trong 3 products reserve failed
// Option 1: Cancel toàn bộ order (hiện tại)
// Option 2: Partial fulfillment (future)
```

### 3. Payment Refund Saga

```javascript
// User request refund after PAID
ORDER_REFUND_REQUEST → PAYMENT_REFUND → INVENTORY_RELEASE → ORDER_REFUNDED
```

### 4. Notification Service

```javascript
// Send email/SMS khi order state thay đổi
ORDER_CANCELLED → NOTIFICATION_SERVICE → Send cancellation email
ORDER_PAID → NOTIFICATION_SERVICE → Send confirmation email
```

---

## 📝 Summary

| Aspect | Implementation |
|--------|----------------|
| **Pattern** | Saga with Event Choreography |
| **Services** | Order (orchestrator), Inventory, Payment |
| **Queues** | `orders`, `inventory`, `STOCK_RESERVED`, `order-events` |
| **Compensation** | Orchestrated by Order Service |
| **Atomicity** | Outbox Pattern (Order only) |
| **Idempotency** | Broker-level (Redis) + Service-level (FSM) |
| **State Machine** | FSM in Order Service |
| **Tracing** | OpenTelemetry with correlationId |
| **Error Handling** | DLQ + Retry + Compensation |

---

**Last Updated:** November 20, 2025  
**Version:** 1.0.0
