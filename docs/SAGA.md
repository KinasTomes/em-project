# 🔄 Saga Pattern - Luồng xử lý và Event Choreography

Tài liệu này mô tả chi tiết các luồng Saga hiện có trong hệ thống E-commerce, bao gồm luồng chính (Happy Path) và các luồng bù trừ (Compensation).

**Ngày cập nhật:** 22/11/2025  
**Phiên bản:** 2.0.0

---

## 📊 Tổng quan kiến trúc

Hệ thống sử dụng **Saga Pattern với Event Choreography** qua RabbitMQ Topic Exchange, bao gồm 5 microservices:

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
                      ┌────────────────────────┐
                      │ RabbitMQ Topic Exchange│
                      │  'ecommerce.events'    │
                      └────────────────────────┘
```

### Queues và Routing Keys

| Service | Queue Name | Routing Keys Subscribe | Mô tả |
|---------|-----------|------------------------|-------|
| Order | `q.order-service` | `inventory.reserved.success`<br>`inventory.reserved.failed`<br>`payment.succeeded`<br>`payment.failed` | Nhận phản hồi từ Inventory và Payment |
| Inventory | `q.inventory-service` | `order.created`<br>`order.release`<br>`payment.failed` | Xử lý reserve/release stock |
| Payment | `q.payment-service` | `order.confirmed` | Xử lý thanh toán khi order confirmed |

---

## 🎯 Luồng 1: Order Creation - Happy Path (Thành công)

### Mô tả
User tạo đơn hàng → Reserve inventory (batch) → Process payment → Order hoàn thành với trạng thái PAID.


### Bảng luồng sự kiện

| Bước | Event Type | Routing Key | Producer | Consumer | Action | Order Status |
|------|-----------|-------------|----------|----------|--------|--------------|
| 1 | `POST /api/orders` | - | Client → API Gateway | Order Service | Tạo Order với status `PENDING` | → `PENDING` |
| 2 | `ORDER_CREATED` | `order.created` | Order Service (Outbox) | Inventory Service | Reserve stock cho **TẤT CẢ** products trong 1 transaction | - |
| 3a | `INVENTORY_RESERVED_SUCCESS` | `inventory.reserved.success` | Inventory Service | Order Service | Tất cả products đã được reserved thành công | `PENDING` → `CONFIRMED` |
| 3b | `ORDER_CONFIRMED` | `order.confirmed` | Order Service (Outbox) | Payment Service | Trigger payment processing | - |
| 4 | `PAYMENT_SUCCEEDED` | `payment.succeeded` | Payment Service | Order Service | Thanh toán thành công | `CONFIRMED` → `PAID` |
| 5 | `ORDER_PAID` | `order.paid` | Order Service (Outbox) | (Future: Notification) | Hoàn tất đơn hàng | - |

### Chi tiết từng bước

#### **Bước 1: User tạo Order**
```javascript
// Request
POST /api/orders
Body: {
  "ids": ["product_1", "product_2"],
  "quantities": [2, 1]
}

// Action: OrderService.createOrder()
- Validate products qua Product Service
- Tạo Order document (status: PENDING)
- Tạo 1 event ORDER_CREATED chứa TẤT CẢ products
- Lưu vào Outbox trong cùng transaction với Order
```

#### **Bước 2: Inventory Reserve (Batch Operation)**
```javascript
// Producer: Order Service → Outbox → OutboxProcessor → RabbitMQ
Event: ORDER_CREATED
Routing Key: order.created
Payload: {
  type: "ORDER_CREATED",
  orderId: "order_123",
  products: [
    { productId: "product_1", quantity: 2 },
    { productId: "product_2", quantity: 1 }
  ]
}

// Consumer: Inventory Service
Action: inventoryService.reserveStockBatch(products)
- Bắt đầu MongoDB Transaction
- Sử dụng bulkWrite để check và reserve TẤT CẢ products trong 1 operation
- Nếu TẤT CẢ đủ stock → Commit transaction
- Nếu BẤT KỲ product nào thiếu → Rollback transaction
```

#### **Bước 3a: Inventory Reserved Success**
```javascript
// Producer: Inventory Service → RabbitMQ
Event: INVENTORY_RESERVED_SUCCESS
Routing Key: inventory.reserved.success
Payload: {
  type: "INVENTORY_RESERVED_SUCCESS",
  data: {
    orderId: "order_123",
    products: [
      { productId: "product_1", quantity: 2 },
      { productId: "product_2", quantity: 1 }
    ],
    timestamp: "2025-11-22T10:30:00Z"
  }
}

// Consumer: Order Service.handleInventoryReserved()
Action:
- Đánh dấu TẤT CẢ products.reserved = true
- Chuyển order.status: PENDING → CONFIRMED (dùng FSM)
- Emit ORDER_CONFIRMED event qua Outbox
```

#### **Bước 3b: Order Confirmed (Trigger Payment)**
```javascript
// Producer: Order Service (Outbox)
Event: ORDER_CONFIRMED
Routing Key: order.confirmed
Payload: {
  orderId: "order_123",
  totalPrice: 299.99,
  currency: "USD",
  products: [
    { productId: "product_1", quantity: 2, price: 99.99 },
    { productId: "product_2", quantity: 1, price: 100.01 }
  ],
  userId: "user_123",
  timestamp: "2025-11-22T10:30:01Z"
}

// Consumer: Payment Service
Action: paymentProcessor.process()
- Check idempotency (Redis)
- Create/Get Payment record (MongoDB)
- Mark as PROCESSING
- Process payment (mock với success rate 90%)
- Update Payment record với result
- Mark as processed (Redis)
```

#### **Bước 4: Payment Success**
```javascript
// Producer: Payment Service → RabbitMQ
Event: PAYMENT_SUCCEEDED
Routing Key: payment.succeeded
Payload: {
  type: "PAYMENT_SUCCEEDED",
  data: {
    orderId: "order_123",
    transactionId: "txn_abc123",
    amount: 299.99,
    currency: "USD",
    processedAt: "2025-11-22T10:30:02Z"
  }
}

// Consumer: Order Service.handlePaymentSucceeded()
Action:
- Validate order.status = CONFIRMED (FSM check)
- Update order.status: CONFIRMED → PAID
- Emit ORDER_PAID event (Outbox)
```

---

## ⚠️ Luồng 2: Inventory Reserve Failed (Thiếu hàng)

### Mô tả
Một hoặc nhiều products không đủ stock → Cancel order ngay lập tức, không reserve product nào cả.

### Bảng luồng sự kiện

| Bước | Event Type | Routing Key | Producer | Consumer | Action | Order Status |
|------|-----------|-------------|----------|----------|--------|--------------|
| 1 | `POST /api/orders` | - | Client → API Gateway | Order Service | Tạo Order với status `PENDING` | → `PENDING` |
| 2 | `ORDER_CREATED` | `order.created` | Order Service (Outbox) | Inventory Service | Kiểm tra stock cho TẤT CẢ products | - |
| 3 | `INVENTORY_RESERVED_FAILED` | `inventory.reserved.failed` | Inventory Service | Order Service | Thiếu stock → Rollback transaction | - |
| 4 | `ORDER_CANCELLED` | `order.cancelled` | Order Service (Outbox) | (Future: Notification) | Hủy order | `PENDING` → `CANCELLED` |

### Chi tiết

#### **Bước 2-3: Inventory Check Failed**
```javascript
// Consumer: Inventory Service.reserveStockBatch()
Action:
- Bắt đầu MongoDB Transaction
- Sử dụng bulkWrite để check TẤT CẢ products
- Phát hiện product_2 chỉ còn 0 units (cần 1)
- Rollback transaction → KHÔNG trừ stock của bất kỳ product nào
- Publish INVENTORY_RESERVED_FAILED

// Producer: Inventory Service → RabbitMQ
Event: INVENTORY_RESERVED_FAILED
Routing Key: inventory.reserved.failed
Payload: {
  type: "INVENTORY_RESERVED_FAILED",
  data: {
    orderId: "order_123",
    products: [
      { productId: "product_1", quantity: 2 },
      { productId: "product_2", quantity: 1 }
    ],
    reason: "Insufficient stock for product product_2. Available: 0, Requested: 1",
    timestamp: "2025-11-22T10:30:00Z"
  }
}

// Consumer: Order Service.handleInventoryReserveFailed()
Action:
- Validate FSM transition: PENDING → CANCELLED
- Set order.status = CANCELLED
- Set order.cancellationReason = "Insufficient stock..."
- Emit ORDER_CANCELLED event (Outbox)
```

**⚠️ Lưu ý quan trọng:**
- Không cần release inventory vì transaction đã rollback
- Không có product nào bị trừ stock
- Order chuyển sang CANCELLED ngay lập tức

---

## 💳 Luồng 3: Payment Failed (Bù trừ - Compensation)

### Mô tả
Stock đã được reserve thành công nhưng thanh toán thất bại → Phải release inventory về lại (compensation).

### Bảng luồng sự kiện

| Bước | Event Type | Routing Key | Producer | Consumer | Action | Order Status |
|------|-----------|-------------|----------|----------|--------|--------------|
| 1-3 | *(Same as Happy Path)* | - | - | - | Order confirmed, stock reserved | - → `CONFIRMED` |
| 4 | `PAYMENT_FAILED` | `payment.failed` | Payment Service | Order Service + Inventory Service | Payment gateway declined | - |
| 5a | `INVENTORY_RELEASE_REQUEST` | `order.release` | Order Service (Outbox) | Inventory Service | **Compensation**: Release stock | - |
| 5b | `ORDER_CANCELLED` | `order.cancelled` | Order Service (Outbox) | (Future: Notification) | Hủy order | `CONFIRMED` → `CANCELLED` |
| 6 | `INVENTORY_RELEASED` | `inventory.released` | Inventory Service | Order Service | Stock đã được trả lại | - |

### Chi tiết

#### **Bước 4: Payment Failed**
```javascript
// Producer: Payment Service
Event: PAYMENT_FAILED
Routing Key: payment.failed
Payload: {
  type: "PAYMENT_FAILED",
  data: {
    orderId: "order_123",
    transactionId: "txn_failed",
    amount: 299.99,
    currency: "USD",
    reason: "Mock gateway declined the payment",
    products: [
      { productId: "product_1", quantity: 2 },
      { productId: "product_2", quantity: 1 }
    ],
    processedAt: "2025-11-22T10:30:02Z"
  }
}

// Consumer 1: Order Service.handlePaymentFailed()
Action:
- Validate order.status = CONFIRMED (FSM check)
- Update order.status = CANCELLED
- Loop qua tất cả reserved products
- Emit INVENTORY_RELEASE_REQUEST cho từng product (Compensation)
- Emit ORDER_CANCELLED event

// Consumer 2: Inventory Service.handlePaymentFailed()
Action:
- Auto-compensation: Release stock cho tất cả products
- Idempotent: Nếu nhận duplicate event → skip
```

#### **Bước 5a: Compensation - Release Inventory**
```javascript
// Producer: Order Service (Outbox)
Event: INVENTORY_RELEASE_REQUEST
Routing Key: order.release
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
Routing Key: inventory.released
Payload: {
  type: "INVENTORY_RELEASED",
  data: {
    orderId: "order_123",
    productId: "product_1",
    quantity: 2
  }
}
```

**⚠️ Lưu ý về Compensation:**
- Có 2 cơ chế compensation song song:
  1. Order Service gửi INVENTORY_RELEASE_REQUEST cho từng product
  2. Inventory Service tự động release khi nhận PAYMENT_FAILED
- Cả 2 đều idempotent nên không gây vấn đề nếu chạy song song

---

## 📋 Bảng tổng hợp Event Types

| Event Type | Producer | Consumer | Routing Key | Purpose |
|------------|----------|----------|-------------|---------|
| `ORDER_CREATED` | Order Service (Outbox) | Inventory Service | `order.created` | Yêu cầu reserve stock cho tất cả products |
| `INVENTORY_RESERVED_SUCCESS` | Inventory Service | Order Service | `inventory.reserved.success` | Xác nhận reserved thành công |
| `INVENTORY_RESERVED_FAILED` | Inventory Service | Order Service | `inventory.reserved.failed` | Thông báo reserve thất bại |
| `ORDER_CONFIRMED` | Order Service (Outbox) | Payment Service | `order.confirmed` | Trigger payment (all stock reserved) |
| `PAYMENT_SUCCEEDED` | Payment Service | Order Service | `payment.succeeded` | Thanh toán thành công |
| `PAYMENT_FAILED` | Payment Service | Order Service + Inventory Service | `payment.failed` | Thanh toán thất bại |
| `INVENTORY_RELEASE_REQUEST` | Order Service (Outbox) | Inventory Service | `order.release` | **Compensation**: Yêu cầu release stock |
| `INVENTORY_RELEASED` | Inventory Service | Order Service | `inventory.released` | Xác nhận released thành công |
| `ORDER_CANCELLED` | Order Service (Outbox) | (Future: Notification) | `order.cancelled` | Đơn hàng bị hủy |
| `ORDER_PAID` | Order Service (Outbox) | (Future: Fulfillment) | `order.paid` | Đơn hàng đã thanh toán |

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
- Payment Service: Check payment status trong database

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

## 🔄 Batch Reserve Operation (Atomic Transaction)

### Mô tả
Inventory Service sử dụng MongoDB Transaction với bulkWrite để đảm bảo tính atomic khi reserve nhiều products.

### Implementation

```javascript
// services/inventory/src/repositories/inventoryRepository.js
async reserveStockBatch(products, session = null) {
  try {
    // Tạo bulk operations cho tất cả products
    const operations = products.map(({ productId, quantity }) => ({
      updateOne: {
        filter: {
          productId: normalizeProductId(productId),
          available: { $gte: quantity }  // ← Check đủ stock
        },
        update: {
          $inc: { available: -quantity, reserved: quantity }
        }
      }
    }));

    const options = session ? { session } : {};
    const result = await Inventory.bulkWrite(operations, options);

    // Kiểm tra tất cả operations thành công
    if (result.modifiedCount !== products.length) {
      // Tìm product nào failed
      for (const { productId, quantity } of products) {
        const inventory = await this.findByProductId(productId);
        if (!inventory || inventory.available < quantity) {
          return {
            success: false,
            failedProduct: productId,
            message: `Insufficient stock for product ${productId}. Available: ${inventory?.available || 0}, Requested: ${quantity}`
          };
        }
      }
    }

    return { success: true, modifiedCount: result.modifiedCount };
  } catch (error) {
    throw error;
  }
}
```

### Ưu điểm
- ✅ **Atomic**: Tất cả products được reserve hoặc không product nào được reserve
- ✅ **Performance**: 1 database round-trip thay vì N queries
- ✅ **Consistency**: Không có trạng thái partial reserve
- ✅ **Transaction Safety**: Rollback tự động nếu có lỗi

### Kịch bản

**Scenario 1: Tất cả products đủ stock**
```
Input: [
  { productId: "A", quantity: 2 },
  { productId: "B", quantity: 1 }
]

Result:
- Product A: available -= 2, reserved += 2 ✓
- Product B: available -= 1, reserved += 1 ✓
- modifiedCount = 2
- Transaction COMMIT
- Publish INVENTORY_RESERVED_SUCCESS
```

**Scenario 2: Một product thiếu stock**
```
Input: [
  { productId: "A", quantity: 2 },  // Available: 5 ✓
  { productId: "B", quantity: 1 }   // Available: 0 ✗
]

Result:
- bulkWrite returns modifiedCount = 1 (chỉ A được update)
- Detect mismatch: modifiedCount (1) !== products.length (2)
- Find failed product: B
- Transaction ROLLBACK
- Product A không bị trừ stock
- Product A không bị trừ stock
- Publish INVENTORY_RESERVED_FAILED
```

---

## 📊 Status Flow Diagram

```
User creates order
       ↓
   [PENDING]
       ├─→ INVENTORY_RESERVED_SUCCESS (all products) → [CONFIRMED]
       │                                            ├─→ PAYMENT_SUCCEEDED → [PAID] ✓
       │                                            └─→ PAYMENT_FAILED → [CANCELLED] ⚠️
       │                                                  ↓
       │                                            (Compensation: Release inventory)
       │
       └─→ INVENTORY_RESERVED_FAILED → [CANCELLED] ✗
```

---

## 🔍 Monitoring & Observability

### Correlation ID

Mỗi saga flow có duy nhất 1 `correlationId` (thường là `orderId`) để trace toàn bộ luồng qua các services.

```javascript
// All events trong cùng saga có cùng correlationId
ORDER_CREATED              correlationId: order_123
INVENTORY_RESERVED_SUCCESS correlationId: order_123
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

### 2. Payment Refund Saga

```javascript
// User request refund after PAID
ORDER_REFUND_REQUEST → PAYMENT_REFUND → INVENTORY_RELEASE → ORDER_REFUNDED
```

### 3. Notification Service

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
| **Queues** | `q.order-service`, `q.inventory-service`, `q.payment-service` |
| **Compensation** | Dual mechanism (Order orchestrated + Inventory auto) |
| **Atomicity** | Outbox Pattern (Order only) + Batch Transaction (Inventory) |
| **Idempotency** | Broker-level (Redis) + Service-level (FSM, DB checks) |
| **State Machine** | FSM in Order Service |
| **Tracing** | OpenTelemetry with correlationId |
| **Error Handling** | DLQ + Retry + Compensation |

---

**Last Updated:** November 22, 2025  
**Version:** 2.0.0
