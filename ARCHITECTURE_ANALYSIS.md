# 🏗️ PHÂN TÍCH KIẾN TRÚC & HIỆU NĂNG HỆ THỐNG

## Mục lục
1. [Tổng quan Kiến trúc Hiện tại](#1-tổng-quan-kiến-trúc-hiện-tại)
2. [Điểm yếu về Kiến trúc](#2-điểm-yếu-về-kiến-trúc)
3. [Điểm yếu về Hiệu năng](#3-điểm-yếu-về-hiệu-năng)
4. [Thiếu sót về Nghiệp vụ E-commerce](#4-thiếu-sót-về-nghiệp-vụ-e-commerce)
5. [Thiếu sót về Infrastructure](#5-thiếu-sót-về-infrastructure)
6. [Đề xuất Kiến trúc Cải tiến](#6-đề-xuất-kiến-trúc-cải-tiến)

---

## 1. Tổng quan Kiến trúc Hiện tại

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API GATEWAY (:3003)                          │
│                    (Simple HTTP Proxy)                          │
└─────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  AUTH SERVICE   │  │ PRODUCT SERVICE │  │  ORDER SERVICE  │
│     (:3000)     │  │     (:3001)     │  │     (:3002)     │
│                 │  │                 │  │                 │
│  MongoDB Auth   │  │ MongoDB Product │  │  MongoDB Order  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
                              │                    │
                              └────────┬───────────┘
                                       ▼
                            ┌─────────────────┐
                            │    RabbitMQ     │
                            │   (:5672)       │
                            └─────────────────┘
```

### Services hiện có:
| Service | Port | Database | Chức năng |
|---------|------|----------|-----------|
| API Gateway | 3003 | - | Proxy requests |
| Auth | 3000 | MongoDB | Login, Register |
| Product | 3001 | MongoDB | CRUD Products, Create Order |
| Order | 3002 | MongoDB | Consume & Save Orders |

---

## 2. Điểm yếu về Kiến trúc

### 2.1 🔴 API Gateway quá đơn giản - Chỉ là HTTP Proxy

**Hiện trạng:**
```javascript
// api-gateway/index.js
app.use("/auth", (req, res) => {
  proxy.web(req, res, { target: "http://auth:3000" });
});
```

**Vấn đề:**
- Chỉ forward request, không có logic gì
- Không có **Load Balancing** khi scale service
- Không có **Request Aggregation** - client phải gọi nhiều API riêng lẻ
- Không có **Response Caching** tại gateway level

**Ảnh hưởng hiệu năng:**
- Mỗi request đều phải đi qua gateway rồi đến service → thêm 1 network hop
- Không tận dụng được cache → database bị query liên tục
- Khi 1 service slow/down → không có fallback, client phải chờ timeout

**Cần có:**
```
┌─────────────────────────────────────────────────────────────────┐
│                        API GATEWAY                               │
├─────────────────────────────────────────────────────────────────┤
│  ✓ Authentication/Authorization                                  │
│  ✓ Rate Limiting                                                │
│  ✓ Load Balancing                                               │
│  ✓ Circuit Breaker                                              │
│  ✓ Request/Response Transformation                              │
│  ✓ Caching                                                      │
│  ✓ Logging & Monitoring                                         │
│  ✓ API Versioning                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

### 2.2 🔴 Tight Coupling giữa Product và Order Service

**Hiện trạng:**
```javascript
// product/src/controllers/productController.js
async createOrder(req, res, next) {
  // Product service tạo order và gửi message
  await messageBroker.publishMessage("orders", {...});
  
  // Rồi lại consume message từ products queue
  messageBroker.consumeMessage("products", (data) => {...});
  
  // Blocking wait cho order complete
  while (order.status !== 'completed') {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

**Vấn đề:**
- **Product Service đang làm việc của Order Service** - vi phạm Single Responsibility
- **Synchronous waiting trong async flow** - blocking thread, giảm throughput
- **Order state được lưu trong memory** (`ordersMap`) - mất data khi restart
- **Circular dependency**: Product → Order → Product

**Ảnh hưởng hiệu năng:**
- 1 request tạo order chiếm 1 connection liên tục cho đến khi complete
- Nếu có 100 concurrent orders → 100 connections bị block
- Memory tăng liên tục vì `ordersMap` không được cleanup

**Kiến trúc đúng:**
```
Client → Product Service (chỉ query products)
       → Order Service (tạo order, trả về order_id ngay)
       → Client poll status hoặc WebSocket notification
```

---

### 2.3 🔴 Thiếu Service Discovery

**Hiện trạng:**
```javascript
// Hardcoded service URLs
proxy.web(req, res, { target: "http://auth:3000" });
proxy.web(req, res, { target: "http://product:3001" });
```

**Vấn đề:**
- Service URLs được hardcode
- Không thể dynamic scale services
- Không thể failover khi instance chết

**Cần có:**
- **Service Registry** (Consul, etcd, hoặc Kubernetes DNS)
- **Health Checks** để biết service nào healthy
- **Dynamic routing** dựa trên service discovery

---

### 2.4 🔴 Không có Saga Pattern cho Distributed Transaction

**Hiện trạng:**
Order flow hiện tại:
```
1. Product Service nhận request
2. Gửi message đến Order queue
3. Order Service consume và save
4. Order Service gửi message về Product queue
5. Product Service update status
```

**Vấn đề:**
- **Không có compensation logic** - nếu step 3 fail, không có rollback
- **Không có transaction boundary** - data có thể inconsistent
- **Không track được order state** across services

**Ví dụ lỗi:**
```
1. Client tạo order với 5 sản phẩm
2. Order được gửi đến queue
3. Order Service crash giữa chừng
4. 3 sản phẩm đã được xử lý, 2 sản phẩm chưa
5. Không có cách nào biết và rollback
```

**Cần có:**
- **Saga Orchestrator** hoặc **Choreography Pattern**
- **Compensation handlers** cho mỗi step
- **Idempotency** để có thể retry safely

---

### 2.5 🟠 Database per Service nhưng không có Event Sourcing

**Hiện trạng:**
- Mỗi service có MongoDB riêng ✓
- Nhưng không có cách sync data giữa các service

**Vấn đề:**
- Product Service cần thông tin user → phải gọi Auth Service
- Order Service cần thông tin product → phải gọi Product Service
- **N+1 problem** khi cần aggregate data

**Cần có:**
- **Event Sourcing** - mỗi service publish events khi data thay đổi
- **CQRS** - tách read/write models
- **Materialized Views** - mỗi service có local copy của data cần

---

### 2.6 🟠 Không có API Composition/Aggregation

**Hiện trạng:**
Client muốn xem order details với product info:
```
1. GET /orders/123 → Order Service → { productIds: [...] }
2. GET /products?ids=1,2,3 → Product Service → [products...]
3. Client tự merge data
```

**Vấn đề:**
- Client phải gọi nhiều API
- Tăng latency (multiple round trips)
- Client phải biết cách compose data

**Cần có:**
- **BFF (Backend for Frontend)** pattern
- **GraphQL** để client query đúng data cần
- **API Composition** tại Gateway level

---

### 2.7 🟠 Message Queue không có Dead Letter Queue

**Hiện trạng:**
```javascript
// order/src/app.js
channel.consume("orders", async (data) => {
  // Nếu fail thì sao?
  const newOrder = new Order({...});
  await newOrder.save();
  channel.ack(data);
});
```

**Vấn đề:**
- Nếu message processing fail → message bị mất hoặc retry vô hạn
- Không có DLQ để analyze failed messages
- Không có retry policy với exponential backoff

**Cần có:**
```javascript
// Proper message handling
channel.consume("orders", async (data) => {
  try {
    await processOrder(data);
    channel.ack(data);
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      channel.nack(data, false, true); // requeue
    } else {
      channel.sendToQueue("orders.dlq", data.content); // dead letter
      channel.ack(data);
    }
  }
});
```

---

## 3. Điểm yếu về Hiệu năng

### 3.1 🔴 Blocking Order Creation - Bottleneck nghiêm trọng

**Hiện trạng:**
```javascript
// product/src/controllers/productController.js
async createOrder(req, res, next) {
  // ...
  while (order.status !== 'completed') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    order = this.ordersMap.get(orderId);
  }
  return res.status(201).json(order);
}
```

**Phân tích hiệu năng:**

| Metric | Giá trị |
|--------|---------|
| Thời gian trung bình 1 order | ~10-15 giây (RabbitMQ delay + processing) |
| Max concurrent orders | Bị giới hạn bởi Node.js event loop |
| Memory per order | Object trong Map + closure |

**Vấn đề:**
- **Long polling trong request handler** - chiếm connection
- **Không scale được** - 1000 concurrent orders = 1000 pending connections
- **Timeout risk** - client/proxy có thể timeout trước khi order complete

**Giải pháp:**
```javascript
// Async pattern
async createOrder(req, res) {
  const orderId = await orderService.initiateOrder(products);
  res.status(202).json({ 
    orderId, 
    status: 'processing',
    statusUrl: `/orders/${orderId}/status`
  });
}

// Client poll status hoặc WebSocket
```

---

### 3.2 🔴 Memory Leak - ordersMap không được cleanup

**Hiện trạng:**
```javascript
constructor() {
  this.ordersMap = new Map(); // Grows forever
}

async createOrder(req, res) {
  this.ordersMap.set(orderId, {...}); // Add
  // Never delete
}
```

**Phân tích:**
- Mỗi order ~1KB (products array, user info)
- 10,000 orders/ngày = 10MB/ngày
- 1 tháng = 300MB chỉ riêng ordersMap
- **Server sẽ OOM (Out of Memory) sau một thời gian**

**Giải pháp:**
```javascript
// TTL-based cleanup
const ORDER_TTL = 3600000; // 1 hour

setInterval(() => {
  const now = Date.now();
  for (const [id, order] of this.ordersMap) {
    if (now - order.createdAt > ORDER_TTL) {
      this.ordersMap.delete(id);
    }
  }
}, 60000);
```

---

### 3.3 🔴 RabbitMQ Connection không được tái sử dụng đúng cách

**Hiện trạng:**
```javascript
// product/src/utils/messageBroker.js
async connect() {
  setTimeout(async () => {
    const connection = await amqp.connect("amqp://rabbitmq:5672");
    this.channel = await connection.createChannel();
  }, 20000); // Hardcoded 20s delay
}
```

**Vấn đề:**
- **Chỉ có 1 channel** cho toàn bộ application
- **Không handle reconnection** khi connection drop
- **Hardcoded delay** thay vì proper health check

**Ảnh hưởng:**
- Nếu RabbitMQ restart → service phải restart theo
- 1 channel = limited throughput (RabbitMQ recommends 1 channel per thread)

**Giải pháp:**
```javascript
class MessageBroker {
  async connect() {
    this.connection = await amqp.connect(url);
    this.connection.on('error', this.handleError);
    this.connection.on('close', this.reconnect);
  }
  
  async getChannel() {
    if (!this.channel || this.channel.closed) {
      this.channel = await this.connection.createChannel();
    }
    return this.channel;
  }
}
```

---

### 3.4 🟠 Không có Database Connection Pooling Configuration

**Hiện trạng:**
```javascript
await mongoose.connect(config.mongoURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
```

**Vấn đề:**
- Dùng default pool size (5 connections)
- Với high traffic, connections sẽ bị exhausted
- Queries sẽ phải wait cho available connection

**Giải pháp:**
```javascript
await mongoose.connect(config.mongoURI, {
  maxPoolSize: 50,
  minPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});
```

---

### 3.5 🟠 Không có Indexing Strategy

**Hiện trạng:**
```javascript
// auth/src/models/user.js
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  password: { type: String, required: true }
});
// No indexes defined
```

**Vấn đề:**
- `findOne({ username })` sẽ full collection scan
- Với 1 triệu users → mỗi login query scan 1 triệu documents

**Query Performance:**

| Users | Without Index | With Index |
|-------|---------------|------------|
| 1,000 | ~5ms | ~1ms |
| 100,000 | ~200ms | ~1ms |
| 1,000,000 | ~2000ms | ~1ms |

**Giải pháp:**
```javascript
UserSchema.index({ username: 1 }, { unique: true });
OrderSchema.index({ user: 1, createdAt: -1 });
ProductSchema.index({ name: 'text', description: 'text' });
```

---

### 3.6 🟠 Không có Response Caching

**Hiện trạng:**
```javascript
async getProducts(req, res) {
  const products = await Product.find({}); // Query DB mỗi request
  res.status(200).json(products);
}
```

**Vấn đề:**
- Mỗi request đều query database
- Product list ít thay đổi nhưng vẫn query liên tục
- Database load cao không cần thiết

**Giải pháp:**
```javascript
const redis = require('redis');
const client = redis.createClient();

async getProducts(req, res) {
  const cached = await client.get('products:all');
  if (cached) {
    return res.json(JSON.parse(cached));
  }
  
  const products = await Product.find({});
  await client.setEx('products:all', 300, JSON.stringify(products)); // 5 min TTL
  res.json(products);
}
```

---

### 3.7 🟡 Không có Request Batching/Debouncing

**Vấn đề với current flow:**
```
Client A → createOrder → publish to queue
Client B → createOrder → publish to queue
Client C → createOrder → publish to queue
// 3 separate DB operations in Order Service
```

**Có thể optimize:**
```
Batch orders every 100ms or 10 orders
→ Single bulk insert
→ Giảm DB round trips
```

---

## 4. Thiếu sót về Nghiệp vụ E-commerce

### 4.1 🔴 Không có Inventory Management

**Hiện trạng:**
- Product chỉ có: `name`, `price`, `description`
- Không có `quantity`, `stock`

**Vấn đề nghiệp vụ:**
- Không kiểm tra tồn kho trước khi order
- Có thể bán quá số lượng có
- Không có reserved stock khi order pending

**Cần có:**
```javascript
const productSchema = new mongoose.Schema({
  name: String,
  price: Number,
  description: String,
  // Inventory fields
  quantity: { type: Number, default: 0 },
  reservedQuantity: { type: Number, default: 0 },
  availableQuantity: { type: Number, get: function() {
    return this.quantity - this.reservedQuantity;
  }},
  lowStockThreshold: { type: Number, default: 10 },
  trackInventory: { type: Boolean, default: true }
});
```

**Flow cần có:**
```
1. Customer adds to cart → Check availability
2. Checkout initiated → Reserve stock (quantity -= X, reservedQuantity += X)
3. Payment success → Confirm reservation
4. Payment failed/timeout → Release reservation
```

---

### 4.2 🔴 Không có Payment Service

**Hiện trạng:**
- Order được tạo trực tiếp không qua payment
- Không có payment status tracking

**Cần có:**
```
┌─────────────────────────────────────────────────────────────────┐
│                      PAYMENT SERVICE                             │
├─────────────────────────────────────────────────────────────────┤
│  • Payment Gateway Integration (Stripe, PayPal, VNPay...)       │
│  • Payment Status: pending → processing → completed/failed      │
│  • Refund handling                                              │
│  • Payment retry logic                                          │
│  • Webhook handlers for async payment confirmation              │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.3 🔴 Không có Cart Service

**Hiện trạng:**
- Không có shopping cart
- Order được tạo trực tiếp với product IDs

**Vấn đề:**
- Không lưu được cart state
- Không có cart abandonment tracking
- Không support guest checkout với persistent cart

**Cần có:**
```javascript
const cartSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User' },
  sessionId: String, // For guest users
  items: [{
    productId: { type: ObjectId, ref: 'Product' },
    quantity: Number,
    priceAtAdd: Number, // Price snapshot
    addedAt: Date
  }],
  expiresAt: Date, // Auto-cleanup old carts
  couponCode: String
});
```

---

### 4.4 🔴 Không có Order Status Lifecycle

**Hiện trạng:**
```javascript
// Chỉ có: pending → completed
this.ordersMap.set(orderId, { status: "pending" });
// ...
this.ordersMap.set(orderId, { ...order, status: 'completed' });
```

**E-commerce cần:**
```
┌──────────┐    ┌───────────┐    ┌──────────┐    ┌───────────┐
│ CREATED  │───▶│  PENDING  │───▶│   PAID   │───▶│ CONFIRMED │
└──────────┘    └───────────┘    └──────────┘    └───────────┘
                     │                                  │
                     ▼                                  ▼
               ┌───────────┐                    ┌───────────┐
               │ CANCELLED │                    │ PROCESSING│
               └───────────┘                    └───────────┘
                                                       │
                     ┌─────────────────────────────────┤
                     ▼                                 ▼
               ┌───────────┐                    ┌───────────┐
               │  SHIPPED  │───────────────────▶│ DELIVERED │
               └───────────┘                    └───────────┘
                     │                                 │
                     ▼                                 ▼
               ┌───────────┐                    ┌───────────┐
               │ RETURNED  │◀──────────────────│ REFUNDED  │
               └───────────┘                    └───────────┘
```

---

### 4.5 🟠 Không có User Profile & Address Management

**Hiện trạng:**
```javascript
// User chỉ có username và password
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  password: { type: String, required: true }
});
```

**E-commerce cần:**
```javascript
const UserSchema = new mongoose.Schema({
  username: String,
  email: { type: String, unique: true },
  password: String,
  profile: {
    firstName: String,
    lastName: String,
    phone: String,
    avatar: String
  },
  addresses: [{
    type: { type: String, enum: ['shipping', 'billing'] },
    isDefault: Boolean,
    fullName: String,
    phone: String,
    street: String,
    city: String,
    state: String,
    country: String,
    postalCode: String
  }],
  preferences: {
    currency: String,
    language: String,
    notifications: {
      email: Boolean,
      sms: Boolean,
      push: Boolean
    }
  }
});
```

---

### 4.6 🟠 Không có Product Categories & Search

**Hiện trạng:**
```javascript
// Product không có category
const productSchema = new mongoose.Schema({
  name: String,
  price: Number,
  description: String
});
```

**Cần có:**
```javascript
const productSchema = new mongoose.Schema({
  name: String,
  slug: { type: String, unique: true },
  price: Number,
  compareAtPrice: Number, // Original price for discounts
  description: String,
  
  // Categorization
  category: { type: ObjectId, ref: 'Category' },
  subcategory: { type: ObjectId, ref: 'Category' },
  tags: [String],
  brand: String,
  
  // Media
  images: [{
    url: String,
    alt: String,
    isPrimary: Boolean
  }],
  
  // Variants
  variants: [{
    sku: String,
    attributes: Map, // { color: 'red', size: 'M' }
    price: Number,
    quantity: Number
  }],
  
  // SEO
  seo: {
    title: String,
    description: String,
    keywords: [String]
  },
  
  // Status
  status: { type: String, enum: ['draft', 'active', 'archived'] },
  publishedAt: Date
});

// Full-text search index
productSchema.index({ 
  name: 'text', 
  description: 'text', 
  'tags': 'text' 
});
```

---

### 4.7 🟠 Không có Pricing & Discount System

**Cần có:**
```javascript
const discountSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  type: { type: String, enum: ['percentage', 'fixed', 'free_shipping'] },
  value: Number,
  
  // Conditions
  minOrderAmount: Number,
  maxDiscountAmount: Number,
  applicableProducts: [{ type: ObjectId, ref: 'Product' }],
  applicableCategories: [{ type: ObjectId, ref: 'Category' }],
  
  // Limits
  usageLimit: Number,
  usageCount: { type: Number, default: 0 },
  perUserLimit: Number,
  
  // Validity
  startDate: Date,
  endDate: Date,
  isActive: Boolean
});
```

---

### 4.8 🟠 Không có Notification Service

**E-commerce cần notify:**
- Order confirmation
- Payment status
- Shipping updates
- Delivery confirmation
- Promotional emails
- Abandoned cart reminders

**Cần có:**
```
┌─────────────────────────────────────────────────────────────────┐
│                   NOTIFICATION SERVICE                           │
├─────────────────────────────────────────────────────────────────┤
│  Channels:                                                       │
│  • Email (SendGrid, SES)                                        │
│  • SMS (Twilio)                                                 │
│  • Push Notifications (Firebase)                                │
│  • In-app Notifications                                         │
│                                                                 │
│  Features:                                                      │
│  • Template management                                          │
│  • Scheduling                                                   │
│  • Delivery tracking                                            │
│  • User preferences                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.9 🟡 Không có Review & Rating System

```javascript
const reviewSchema = new mongoose.Schema({
  productId: { type: ObjectId, ref: 'Product' },
  userId: { type: ObjectId, ref: 'User' },
  orderId: { type: ObjectId, ref: 'Order' }, // Verify purchase
  rating: { type: Number, min: 1, max: 5 },
  title: String,
  content: String,
  images: [String],
  isVerifiedPurchase: Boolean,
  helpfulCount: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'] }
});
```

---

### 4.10 🟡 Không có Shipping Service

```javascript
const shippingSchema = new mongoose.Schema({
  orderId: { type: ObjectId, ref: 'Order' },
  carrier: String, // 'ghn', 'ghtk', 'viettel_post'
  trackingNumber: String,
  status: { 
    type: String, 
    enum: ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed']
  },
  estimatedDelivery: Date,
  actualDelivery: Date,
  shippingCost: Number,
  events: [{
    status: String,
    location: String,
    timestamp: Date,
    description: String
  }]
});
```

---

## 5. Thiếu sót về Infrastructure

### 5.1 🔴 Không có Centralized Logging

**Hiện trạng:**
```javascript
console.log("MongoDB connected");
console.error("Failed to connect to RabbitMQ:", err.message);
```

**Vấn đề:**
- Logs phân tán ở mỗi container
- Không thể trace request across services
- Không có log aggregation

**Cần có:**
```
┌─────────────────────────────────────────────────────────────────┐
│                         ELK Stack                                │
│  ┌───────────┐    ┌───────────────┐    ┌──────────────┐        │
│  │  Logstash │───▶│ Elasticsearch │◀───│    Kibana    │        │
│  └───────────┘    └───────────────┘    └──────────────┘        │
│        ▲                                                        │
│        │                                                        │
│  ┌─────┴─────┬──────────────┬──────────────┐                   │
│  │   Auth    │   Product    │    Order     │                   │
│  │  Service  │   Service    │   Service    │                   │
│  └───────────┴──────────────┴──────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

---

### 5.2 🔴 Không có Distributed Tracing

**Vấn đề:**
- Không thể trace 1 request qua nhiều services
- Khó debug khi có lỗi
- Không biết bottleneck ở đâu

**Cần có:**
- **Jaeger** hoặc **Zipkin** cho distributed tracing
- **Correlation ID** trong mỗi request
- **OpenTelemetry** integration

```javascript
// Mỗi request cần có correlation ID
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || uuid();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});
```

---

### 5.3 🔴 Không có Health Checks

**Hiện trạng:**
- Không có `/health` endpoint
- Docker không biết service có healthy không
- Kubernetes không thể làm liveness/readiness probes

**Cần có:**
```javascript
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    checks: {
      database: await checkDatabase(),
      rabbitmq: await checkRabbitMQ(),
      memory: process.memoryUsage(),
      uptime: process.uptime()
    }
  };
  res.json(health);
});

app.get('/ready', async (req, res) => {
  // Check if service is ready to accept traffic
  const isReady = await checkDependencies();
  res.status(isReady ? 200 : 503).json({ ready: isReady });
});
```

---

### 5.4 🟠 Không có Metrics & Monitoring

**Cần có:**
```
┌─────────────────────────────────────────────────────────────────┐
│                      Prometheus + Grafana                        │
├─────────────────────────────────────────────────────────────────┤
│  Metrics to collect:                                            │
│  • Request rate, latency, error rate (RED)                      │
│  • Database query performance                                   │
│  • Message queue depth                                          │
│  • Memory/CPU usage                                             │
│  • Business metrics (orders/hour, revenue, etc.)                │
└─────────────────────────────────────────────────────────────────┘
```

---

### 5.5 🟠 Không có Caching Layer

**Cần có:**
```
┌─────────────────────────────────────────────────────────────────┐
│                          Redis                                   │
├─────────────────────────────────────────────────────────────────┤
│  Use cases:                                                     │
│  • Session storage                                              │
│  • API response caching                                         │
│  • Rate limiting counters                                       │
│  • Real-time inventory                                          │
│  • Shopping cart (for fast access)                              │
│  • Pub/Sub for real-time updates                                │
└─────────────────────────────────────────────────────────────────┘
```

---

### 5.6 🟠 Không có Configuration Management

**Hiện trạng:**
- Config hardcoded hoặc trong `.env` files
- Không thể thay đổi config mà không restart

**Cần có:**
- **Config Service** (Spring Cloud Config, Consul)
- **Feature Flags** (LaunchDarkly, Unleash)
- **Dynamic configuration** reload

---

### 5.7 🟡 Không có CI/CD Pipeline Definition

**Cần có:**
```yaml
# .github/workflows/ci.yml
stages:
  - lint
  - test
  - security-scan
  - build
  - push
  - deploy-staging
  - integration-test
  - deploy-production
```

---

## 6. Đề xuất Kiến trúc Cải tiến

### Target Architecture

```
                                    ┌─────────────────┐
                                    │   CDN (Static)  │
                                    └────────┬────────┘
                                             │
┌────────────────────────────────────────────┼────────────────────────────────────────────┐
│                                            │                                             │
│    ┌───────────────────────────────────────┼───────────────────────────────────────┐    │
│    │                              Load Balancer                                     │    │
│    └───────────────────────────────────────┼───────────────────────────────────────┘    │
│                                            │                                             │
│    ┌───────────────────────────────────────┼───────────────────────────────────────┐    │
│    │                          API Gateway (Kong/Traefik)                            │    │
│    │  • Authentication  • Rate Limiting  • Circuit Breaker  • Caching              │    │
│    └───────────────────────────────────────┼───────────────────────────────────────┘    │
│                                            │                                             │
│    ┌──────────┬──────────┬──────────┬──────┴─────┬──────────┬──────────┬──────────┐    │
│    │          │          │          │            │          │          │          │    │
│    ▼          ▼          ▼          ▼            ▼          ▼          ▼          ▼    │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐ ┌──────────┐ ┌──────┐ ┌──────┐ ┌────────┐   │
│ │ Auth │ │ User │ │Product│ │ Inventory│ │   Cart   │ │Order │ │Payment│ │Shipping│   │
│ └──┬───┘ └──┬───┘ └──┬───┘ └────┬─────┘ └────┬─────┘ └──┬───┘ └──┬───┘ └───┬────┘   │
│    │        │        │          │            │          │        │         │         │
│    └────────┴────────┴──────────┴────────────┴──────────┴────────┴─────────┘         │
│                                            │                                          │
│    ┌───────────────────────────────────────┼───────────────────────────────────────┐  │
│    │                        Message Broker (RabbitMQ/Kafka)                         │  │
│    └───────────────────────────────────────┼───────────────────────────────────────┘  │
│                                            │                                          │
│    ┌───────────────────────────────────────┼───────────────────────────────────────┐  │
│    │                                       │                                        │  │
│    │   ┌─────────┐  ┌─────────┐  ┌────────┴────────┐  ┌─────────────────────────┐  │  │
│    │   │ MongoDB │  │  Redis  │  │  Elasticsearch  │  │    Object Storage (S3)  │  │  │
│    │   │ Cluster │  │ Cluster │  │     Cluster     │  │                         │  │  │
│    │   └─────────┘  └─────────┘  └─────────────────┘  └─────────────────────────┘  │  │
│    │                          Data Layer                                            │  │
│    └────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│    ┌────────────────────────────────────────────────────────────────────────────────┐  │
│    │                         Observability Stack                                     │  │
│    │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │  │
│    │   │  Prometheus  │  │   Grafana    │  │    Jaeger    │  │     ELK      │      │  │
│    │   │   Metrics    │  │  Dashboards  │  │   Tracing    │  │   Logging    │      │  │
│    │   └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘      │  │
│    └────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Kết luận

Hệ thống hiện tại là một **prototype/demo** tốt nhưng **không production-ready**. Các vấn đề chính:

1. **Kiến trúc**: Tight coupling, thiếu service discovery, không có saga pattern
2. **Hiệu năng**: Blocking operations, memory leaks, không có caching
3. **Nghiệp vụ**: Thiếu nhiều core features (inventory, payment, cart, shipping)
4. **Infrastructure**: Không có observability, health checks, proper configuration

Cần refactor đáng kể trước khi deploy production với real traffic.