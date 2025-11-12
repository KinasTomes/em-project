# Order Service - Event Handlers with Outbox Pattern

## ✅ Refactored: All event handlers now use Transactional Outbox Pattern

### 📊 Overview

All event handlers in Order Service now use **MongoDB Transactions + Outbox Pattern** to ensure:
- ✅ **Atomicity:** DB updates and event publishing in same transaction
- ✅ **Consistency:** No partial updates or lost events
- ✅ **Reliability:** At-least-once delivery via OutboxProcessor
- ✅ **Idempotency:** Safe to process duplicate events

---

## 🎯 Event Handlers

### 1. **INVENTORY_RESERVED** (Happy Path)

**Trigger:** Inventory Service successfully reserved stock for a product

**Actions:**
```javascript
MongoDB Transaction {
  1. Mark product as reserved in Order.products[]
  2. If all products reserved:
     - Update Order.status = "CONFIRMED"
     - Create Outbox event: ORDER_CONFIRMED
  3. Commit transaction
}

OutboxProcessor (background):
  - Publish ORDER_CONFIRMED to RabbitMQ
```

**Database Changes:**
- ✅ `orders` collection: `products[].reserved = true`, `status = "CONFIRMED"`
- ✅ `order_outbox` collection: New event with `eventType: "ORDER_CONFIRMED"`

**Published Events:**
- `ORDER_CONFIRMED` → Notification Service

---

### 2. **INVENTORY_RESERVE_FAILED** (Compensation - Scenario 1)

**Trigger:** Inventory Service cannot reserve stock (insufficient stock)

**Actions:**
```javascript
MongoDB Transaction {
  1. Update Order.status = "CANCELLED"
  2. For each previously reserved product:
     - Create Outbox event: RELEASE (compensation)
  3. Create Outbox event: ORDER_CANCELLED
  4. Commit transaction
}

OutboxProcessor (background):
  - Publish RELEASE events to Inventory Service
  - Publish ORDER_CANCELLED to Notification Service
```

**Database Changes:**
- ✅ `orders` collection: `status = "CANCELLED"`
- ✅ `order_outbox` collection: Multiple RELEASE + ORDER_CANCELLED events

**Published Events:**
- `RELEASE` (compensation) → Inventory Service
- `ORDER_CANCELLED` → Notification Service

**Saga Compensation:** Yes - releases any previously reserved items

---

### 3. **PAYMENT_COMPLETED** (Happy Path)

**Trigger:** Payment Service successfully processed payment

**Actions:**
```javascript
MongoDB Transaction {
  1. Update Order.status = "PAID"
  2. Create Outbox event: ORDER_PAID
  3. Commit transaction
}

OutboxProcessor (background):
  - Publish ORDER_PAID to RabbitMQ
```

**Database Changes:**
- ✅ `orders` collection: `status = "PAID"`
- ✅ `order_outbox` collection: New event with `eventType: "ORDER_PAID"`

**Published Events:**
- `ORDER_PAID` → Notification Service

---

### 4. **PAYMENT_FAILED** (Compensation - Scenario 2) 🆕

**Trigger:** Payment Service failed to process payment

**Actions:**
```javascript
MongoDB Transaction {
  1. Update Order.status = "CANCELLED"
  2. For EACH product in order:
     - Create Outbox event: RELEASE (compensation)
  3. Create Outbox event: ORDER_CANCELLED
  4. Commit transaction
}

OutboxProcessor (background):
  - Publish RELEASE events to Inventory Service (returns stock)
  - Publish ORDER_CANCELLED to Notification Service
```

**Database Changes:**
- ✅ `orders` collection: `status = "CANCELLED"`
- ✅ `order_outbox` collection: Multiple RELEASE + ORDER_CANCELLED events

**Published Events:**
- `RELEASE` (compensation) → Inventory Service
- `ORDER_CANCELLED` → Notification Service

**Saga Compensation:** Yes - releases ALL reserved inventory

---

## 📋 Event Types Published by Order Service

| Event Type | Trigger | Destination | Purpose |
|------------|---------|-------------|---------|
| `RESERVE` | Order created (REST API) | Inventory | Request stock reservation |
| `ORDER_CONFIRMED` | All items reserved | Notification | Notify user order confirmed |
| `ORDER_PAID` | Payment successful | Notification | Notify user payment received |
| `ORDER_CANCELLED` | Reservation/Payment failed | Notification | Notify user order cancelled |
| `RELEASE` | Compensation (failure) | Inventory | Return reserved stock |

---

## 📋 Event Types Consumed by Order Service

| Event Type | Source | Handler | Outbox Used? |
|------------|--------|---------|--------------|
| `INVENTORY_RESERVED` | Inventory Service | Update order, publish ORDER_CONFIRMED | ✅ Yes |
| `INVENTORY_RESERVE_FAILED` | Inventory Service | Cancel order, release items | ✅ Yes |
| `PAYMENT_COMPLETED` | Payment Service | Mark order as PAID | ✅ Yes |
| `PAYMENT_FAILED` | Payment Service | Cancel order, release items | ✅ Yes |

---

## 🔄 Saga Flows

### **Happy Path:**
```
1. POST /api/orders (REST)
   └─ Transaction: Save Order + Outbox(RESERVE)
2. OutboxProcessor → Publish RESERVE
3. Inventory Service → INVENTORY_RESERVED
4. Order Service → Transaction: Update Order + Outbox(ORDER_CONFIRMED)
5. OutboxProcessor → Publish ORDER_CONFIRMED
6. Payment Service → PAYMENT_COMPLETED
7. Order Service → Transaction: Update Order + Outbox(ORDER_PAID)
8. OutboxProcessor → Publish ORDER_PAID
9. Notification Service → Send email
```

**Final State:** Order.status = "PAID" ✅

---

### **Unhappy Path 1: Insufficient Stock**
```
1. POST /api/orders (REST)
   └─ Transaction: Save Order + Outbox(RESERVE)
2. OutboxProcessor → Publish RESERVE
3. Inventory Service → INVENTORY_RESERVE_FAILED (not enough stock)
4. Order Service → Transaction:
   - Update Order.status = "CANCELLED"
   - Outbox(RELEASE) for reserved items (compensation)
   - Outbox(ORDER_CANCELLED)
5. OutboxProcessor → Publish RELEASE + ORDER_CANCELLED
6. Inventory Service → Release reserved stock
7. Notification Service → Send cancellation email
```

**Final State:** Order.status = "CANCELLED" ❌

---

### **Unhappy Path 2: Payment Failed**
```
1. POST /api/orders (REST)
   └─ Transaction: Save Order + Outbox(RESERVE)
2. OutboxProcessor → Publish RESERVE
3. Inventory Service → INVENTORY_RESERVED
4. Order Service → Transaction: Update Order + Outbox(ORDER_CONFIRMED)
5. OutboxProcessor → Publish ORDER_CONFIRMED
6. Payment Service → PAYMENT_FAILED (card declined)
7. Order Service → Transaction (COMPENSATION):
   - Update Order.status = "CANCELLED"
   - Outbox(RELEASE) for ALL products
   - Outbox(ORDER_CANCELLED)
8. OutboxProcessor → Publish RELEASE + ORDER_CANCELLED
9. Inventory Service → Release ALL reserved stock
10. Notification Service → Send cancellation email
```

**Final State:** Order.status = "CANCELLED" ❌

---

## 🎯 Key Benefits

### **Before Outbox (Direct Publish):**
```
❌ Update DB
❌ Publish event → RabbitMQ down → MESSAGE LOST
❌ Inconsistent state
```

### **After Outbox (Transactional):**
```
✅ Transaction:
   - Update DB
   - Save event to outbox
   - Commit (both succeed or both fail)
✅ OutboxProcessor → Publish later
✅ Auto-retry if RabbitMQ down
✅ No lost messages
```

---

## 🔧 Implementation Details

### **Transaction Pattern:**
```javascript
const session = await mongoose.startSession();
session.startTransaction();

try {
  // 1. Update Order
  order.status = "CONFIRMED";
  await order.save({ session });

  // 2. Create Outbox event (same transaction)
  await this.outboxManager.createEvent({
    eventType: "ORDER_CONFIRMED",
    payload: { orderId },
    session,  // ← CRITICAL: Same transaction!
    correlationId: orderId
  });

  // 3. Commit (atomic)
  await session.commitTransaction();
} catch (error) {
  // Rollback on error
  await session.abortTransaction();
  throw error;
} finally {
  session.endSession();
}
```

### **Idempotency:**
- Each event has unique `eventId` (UUID)
- Consumer services check Redis/DB for duplicate `eventId`
- Safe to process same event multiple times

### **Observability:**
- All events have `correlationId` (= orderId)
- Links to OpenTelemetry `traceId` for distributed tracing
- View entire Saga flow in Jaeger UI

---

## 📊 Database Schema

### **order_outbox collection:**
```javascript
{
  _id: ObjectId("..."),
  eventType: "ORDER_CONFIRMED",
  payload: {
    orderId: "order_123",
    timestamp: "2025-11-12T10:30:00Z"
  },
  eventId: "evt_abc123",           // Unique (idempotency)
  correlationId: "order_123",      // Trace across services
  status: "PENDING",               // PENDING → PUBLISHED → FAILED
  retries: 0,
  createdAt: ISODate("..."),
  publishedAt: null
}
```

---

## ⚠️ Requirements

### **MongoDB Replica Set:**
Transactions require MongoDB Replica Set. If running standalone:

```yaml
# docker-compose.yml
mongodb:
  command: --replSet rs0

# Initialize:
docker exec -it mongodb mongosh
> rs.initiate()
```

### **Cleanup:**
Add cronjob to delete old published events:
```javascript
// Delete events older than 30 days
db.order_outbox.deleteMany({
  status: "PUBLISHED",
  publishedAt: { $lt: new Date(Date.now() - 30*24*60*60*1000) }
});
```

---

## 📚 Related Files

- `services/order/src/app.js` - Event handlers (Lines 114-350)
- `services/order/src/services/orderService.js` - createOrder() with Outbox
- `packages/outbox-pattern/` - Shared Outbox Pattern package
- `services/order/OUTBOX_INTEGRATION.md` - Outbox setup documentation

---

**Status:** ✅ COMPLETED  
**Last Updated:** 2025-11-12  
**Breaking Changes:** None (backward compatible with fallback)
