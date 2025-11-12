# Outbox Pattern Integration - Order Service

## ✅ Hoàn thành tích hợp Transactional Outbox Pattern

### 📦 Những gì đã thực hiện:

#### 1. **Dependencies**
- ✅ Added `@ecommerce/outbox-pattern: workspace:*` to `package.json`

#### 2. **App.js Changes**
- ✅ Import `OutboxManager` từ shared package
- ✅ Initialize `outboxManager` trong constructor
- ✅ Start `OutboxProcessor` khi service khởi động
- ✅ Pass `outboxManager` xuống `OrderService`

#### 3. **OrderService.js Changes**
- ✅ Accept `outboxManager` parameter trong constructor
- ✅ Sử dụng **MongoDB Transaction** trong `createOrder()`
- ✅ Lưu Order và Outbox events trong **cùng 1 transaction**
- ✅ Commit transaction khi thành công
- ✅ Rollback transaction khi có lỗi
- ✅ Fallback to direct publish nếu outboxManager không available

---

## 🔄 Workflow mới:

### **Trước khi có Outbox Pattern:**
```
POST /api/orders
  ├─ Save Order to DB
  └─ Publish RESERVE to RabbitMQ  ← Không atomic, có thể mất message
```

**Vấn đề:** Nếu save DB thành công nhưng publish fail → **Data inconsistency**

---

### **Sau khi có Outbox Pattern:**
```
POST /api/orders
  └─ MongoDB Transaction:
      ├─ Save Order to orders collection
      └─ Save RESERVE events to order_outbox collection
      └─ Commit (atomic)

OutboxProcessor (background):
  ├─ Watch order_outbox collection (Change Stream)
  ├─ Detect new events with status: PENDING
  ├─ Publish to RabbitMQ
  └─ Update status: PUBLISHED
```

**Giải pháp:** 
- ✅ Order và Events được lưu trong 1 transaction → **Atomic**
- ✅ Nếu RabbitMQ down → Events vẫn an toàn trong DB
- ✅ Auto retry khi RabbitMQ up lại
- ✅ At-least-once delivery guarantee

---

## 📊 Database Structure:

### **orders collection:**
```javascript
{
  _id: ObjectId("..."),
  products: [
    { _id, name, price, quantity, reserved: false }
  ],
  user: "john_doe",
  totalPrice: 150.00,
  status: "PENDING",
  createdAt: ISODate("...")
}
```

### **order_outbox collection:** (NEW!)
```javascript
{
  _id: ObjectId("..."),
  eventType: "RESERVE",
  payload: {
    orderId: "...",
    productId: "...",
    quantity: 2
  },
  eventId: "evt_abc123",         // Unique ID for idempotency
  correlationId: "order_xyz789", // For distributed tracing
  status: "PENDING",             // PENDING → PUBLISHED → FAILED
  retries: 0,
  createdAt: ISODate("..."),
  publishedAt: null
}
```

---

## 🚀 Cách test:

### 1. **Start services:**
```bash
# Install dependencies
pnpm install

# Start Order Service
cd services/order
pnpm start
```

### 2. **Create order:**
```bash
POST http://localhost:3002/api/orders
Authorization: Bearer <token>
Content-Type: application/json

{
  "productIds": ["prod1", "prod2"],
  "quantities": [2, 1]
}
```

### 3. **Kiểm tra database:**
```javascript
// MongoDB shell
use ecommerce_order;

// Check order
db.orders.find().pretty();

// Check outbox events
db.order_outbox.find().pretty();

// Should see events with status: "PUBLISHED" after processor runs
```

### 4. **Logs to observe:**
```
✓ [Order] OutboxManager initialized
✓ [Order] OutboxProcessor started
✓ Order created successfully
✓ RESERVE events saved to outbox (transactional)
✓ Transaction committed successfully
📝 Creating outbox event (eventType: RESERVE)
✓ Outbox event created
📤 Publishing event to RabbitMQ...
✓ Event published successfully
```

---

## ⚠️ Important Notes:

### **Transaction Requirements:**
- MongoDB **Replica Set** is required for transactions
- If running single MongoDB instance, add to `mongod.conf`:
  ```yaml
  replication:
    replSetName: "rs0"
  ```
- Initialize replica set:
  ```javascript
  rs.initiate()
  ```

### **Fallback Behavior:**
- If `outboxManager` is null → Falls back to direct publish
- This ensures backward compatibility during migration

### **Idempotency:**
- Each event has unique `eventId`
- Consumer services should check `eventId` to avoid duplicate processing

### **Cleanup:**
- Consider adding cronjob to delete old PUBLISHED events:
  ```javascript
  // Delete events older than 30 days
  db.order_outbox.deleteMany({
    status: "PUBLISHED",
    publishedAt: { $lt: new Date(Date.now() - 30*24*60*60*1000) }
  });
  ```

---

## 🎯 Benefits:

✅ **Consistency:** Order và Events luôn được lưu cùng nhau  
✅ **Reliability:** Không mất events khi RabbitMQ down  
✅ **Observability:** Có thể query events history từ DB  
✅ **Retry:** Auto retry với exponential backoff  
✅ **Tracing:** CorrelationId cho distributed tracing  
✅ **Idempotency:** EventId để tránh duplicate processing  

---

## 📚 Related Files:

- `packages/outbox-pattern/` - Shared Outbox Pattern package
- `services/order/src/app.js` - OutboxManager initialization
- `services/order/src/services/orderService.js` - Transaction usage
- `services/order/package.json` - Dependencies

---

## 🔗 Next Steps:

1. ✅ Setup MongoDB Replica Set for transactions
2. ✅ Test with RabbitMQ down scenario
3. ✅ Add monitoring for outbox processing lag
4. ✅ Implement cleanup cronjob for old events
5. ✅ Add metrics for outbox size and processing time

---

**Status:** ✅ COMPLETED  
**Last Updated:** 2025-11-12
