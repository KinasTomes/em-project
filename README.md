# 🛒 E-Commerce Microservices Platform

> **Bài tập lớn Kiến trúc Phần mềm**

---

## 👥 Nhóm 6
- **Trịnh Quang Hưng**
- **Nguyễn Minh Chiến**
- **Nguyễn Đình Bình**

---

## 📌 Bản gốc

- [nicholas-gcc/nodejs-ecommerce-microservice](https://github.com/nicholas-gcc/nodejs-ecommerce-microservice)

---

## 📋 Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Kiến trúc hệ thống](#2-kiến-trúc-hệ-thống)
3. [So sánh với bản gốc](#3-so-sánh-với-bản-gốc)
4. [Các tính năng đã cải tiến](#4-các-tính-năng-đã-cải-tiến)
5. [Hướng dẫn cài đặt](#5-hướng-dẫn-cài-đặt)
6. [API Documentation](#6-api-documentation)

---

## 1. Tổng quan

Dự án này là phiên bản cải tiến của hệ thống e-commerce microservices, tập trung vào việc giải quyết các vấn đề về kiến trúc, hiệu năng và độ tin cậy của bản gốc.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js |
| Framework | Express.js |
| Database | MongoDB (per service) |
| Message Broker | RabbitMQ (Topic Exchange) |
| Cache | Redis |
| Tracing | Jaeger + OpenTelemetry |
| Metrics | Prometheus + Grafana |
| Container | Docker + Docker Compose |

---

## 2. Kiến trúc hệ thống

### 2.1 Kiến trúc bản gốc (Vấn đề)

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
└─────────────────┘  └─────────────────┘  └─────────────────┘
                              │                    │
                              └────────┬───────────┘
                                       ▼
                            ┌─────────────────┐
                            │    RabbitMQ     │
                            └─────────────────┘
```

**Vấn đề chính:**
- API Gateway chỉ forward request, không có logic
- Tight coupling giữa Product và Order Service
- Không có Inventory, Payment Service
- Không có distributed tracing, metrics
- Blocking order creation (memory leak)
- Không có Dead Letter Queue, retry logic

### 2.2 Kiến trúc cải tiến (Nhóm 6)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  CLIENT                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            API GATEWAY (:3003)                               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │Rate Limiting│ │    CORS     │ │     JWT     │ │   Metrics   │           │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘           │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────────┐           │
│  │   Tracing   │ │  Logging    │ │  Keep-Alive Connection Pool │           │
│  └─────────────┘ └─────────────┘ └─────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
          │              │              │              │              │
          ▼              ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│     AUTH     │ │   PRODUCT    │ │    ORDER     │ │  INVENTORY   │ │   PAYMENT    │
│   (:3001)    │ │   (:3004)    │ │   (:3002)    │ │   (:3005)    │ │   (:3006)    │
│              │ │              │ │              │ │              │ │              │
│  MongoDB     │ │  MongoDB     │ │  MongoDB     │ │  MongoDB     │ │  MongoDB     │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
                                         │
                                         ▼
                        ┌────────────────────────────────┐
                        │     SECKILL SERVICE (:3007)    │
                        │        (Flash Sale)            │
                        │                                │
                        │  Redis (Lua Scripts)           │
                        └────────────────────────────────┘
                                         │
          ┌──────────────────────────────┼──────────────────────────────┐
          ▼                              ▼                              ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│    RabbitMQ      │        │      Redis       │        │     Jaeger       │
│  Topic Exchange  │        │   (Idempotency)  │        │    (Tracing)     │
│  + DLQ           │        │   (Caching)      │        │                  │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

---

## 3. So sánh với bản gốc

### 3.1 Điểm yếu về Kiến trúc (Bản gốc)

| Vấn đề | Bản gốc | Nhóm 6 đã giải quyết |
|--------|---------|---------------------|
| **API Gateway đơn giản** | Chỉ forward request | ✅ Rate Limiting, CORS, JWT Auth, Metrics, Tracing |
| **Tight Coupling** | Product Service tạo Order | ✅ Tách riêng Order Service, Event-Driven |
| **Thiếu Service Discovery** | Hardcoded URLs | ⚠️ Docker DNS (có thể mở rộng Consul) |
| **Không có Saga Pattern** | Không có compensation | ✅ Choreography Saga với Outbox Pattern |
| **Không có Event Sourcing** | Không sync data | ✅ Event-Driven với RabbitMQ Topic Exchange |
| **Không có DLQ** | Message mất khi fail | ✅ Dead Letter Queue cho mỗi service |

### 3.2 Điểm yếu về Hiệu năng (Bản gốc)

| Vấn đề | Bản gốc | Nhóm 6 đã giải quyết |
|--------|---------|---------------------|
| **Blocking Order Creation** | While loop chờ complete | ✅ Async với Event-Driven |
| **Memory Leak (ordersMap)** | Map không cleanup | ✅ Không dùng in-memory state |
| **RabbitMQ Connection** | 1 channel, không reconnect | ✅ Auto-reconnect, re-register consumers |
| **Không có Connection Pooling** | Default pool size | ✅ Configured maxPoolSize |
| **Không có Indexing** | Full collection scan | ✅ Indexes trên các fields quan trọng |
| **Không có Caching** | Query DB mỗi request | ✅ Redis caching |

### 3.3 Thiếu sót về Nghiệp vụ (Bản gốc)

| Vấn đề | Bản gốc | Nhóm 6 đã giải quyết |
|--------|---------|---------------------|
| **Không có Inventory** | Không kiểm tra tồn kho | ✅ Inventory Service với reserve/release |
| **Không có Payment** | Order không qua payment | ✅ Payment Service với idempotency |
| **Order Status đơn giản** | Chỉ pending → completed | ✅ State Machine (PENDING → CONFIRMED → PAID) |
| **Không có Flash Sale** | - | ✅ Seckill Service với Redis Lua Scripts |

### 3.4 Thiếu sót về Infrastructure (Bản gốc)

| Vấn đề | Bản gốc | Nhóm 6 đã giải quyết |
|--------|---------|---------------------|
| **Không có Logging** | console.log | ✅ Structured logging với @ecommerce/logger |
| **Không có Tracing** | Không trace được | ✅ Jaeger + OpenTelemetry |
| **Không có Health Checks** | - | ✅ /health endpoint mỗi service |
| **Không có Metrics** | - | ✅ Prometheus metrics |

---

## 4. Các tính năng đã cải tiến

### 4.1 ✅ Shared Packages (Monorepo)

```
packages/
├── circuit-breaker/     # Resilient HTTP Client
├── config/              # Shared configuration
├── logger/              # Structured logging (Pino)
├── message-broker/      # RabbitMQ wrapper với idempotency
├── metrics/             # Prometheus metrics
├── outbox-pattern/      # Transactional messaging
└── tracing/             # OpenTelemetry + Jaeger
```

### 4.2 ✅ Circuit Breaker Pattern

```javascript
const { createResilientClient } = require('@ecommerce/circuit-breaker');

const productClient = createResilientClient('product-service', 'http://product:3004', {
  timeout: 5000,
  retry: { retries: 3 },
  circuitBreaker: { errorThresholdPercentage: 50 }
});
```

**Features:**
- Hard timeout (default 3s)
- Automatic retry với exponential backoff
- Circuit breaker để prevent cascading failures
- Distributed tracing integration

### 4.3 ✅ Outbox Pattern (Transactional Messaging)

```javascript
const session = await mongoose.startSession();
session.startTransaction();

// Business logic + Event trong cùng transaction
await Order.create([orderData], { session });
await outboxManager.createEvent({
  eventType: 'ORDER_CREATED',
  payload: { orderId, products },
  session,
  routingKey: 'order.created'
});

await session.commitTransaction();
```

**Đảm bảo:**
- Atomicity: Business logic và event được commit cùng nhau
- At-least-once delivery: Event sẽ được publish
- Idempotency: Duplicate events được handle

### 4.4 ✅ Order State Machine

```
┌─────────┐     confirm()     ┌───────────┐      pay()      ┌────────┐
│ PENDING │──────────────────▶│ CONFIRMED │────────────────▶│  PAID  │
└─────────┘                   └───────────┘                 └────────┘
     │                              │
     │         cancel()             │         cancel()
     └──────────────┬───────────────┘
                    ▼
              ┌───────────┐
              │ CANCELLED │
              └───────────┘
```

**Rules:**
- Order MUST be CONFIRMED before PAID
- Cannot transition directly PENDING → PAID
- Idempotent transitions (already in target state = success)

### 4.5 ✅ Seckill Service (Flash Sale)

```javascript
// Atomic Lua Script cho reserve
const result = await redisClient.evalSha('reserve', {
  keys: [stockKey, usersKey, rateLimitKey],
  arguments: [userId, rateLimit, rateWindow]
});
```

**Features:**
- Redis Lua Scripts cho atomic operations
- Rate limiting per user
- Duplicate purchase prevention
- Ghost Order fallback (emergency log)

### 4.6 ✅ Event-Driven Architecture

```
┌─────────────┐    order.created    ┌─────────────────┐
│   Order     │────────────────────▶│   Inventory     │
│   Service   │                     │   Service       │
└─────────────┘                     └─────────────────┘
                                           │
                                           │ inventory.reserved.success
                                           ▼
┌─────────────┐   payment.succeeded ┌─────────────────┐
│   Order     │◀────────────────────│    Payment      │
│   Service   │                     │    Service      │
└─────────────┘                     └─────────────────┘
```

**Routing Keys:**
- `order.created` → Inventory reserves stock
- `inventory.reserved.success` → Payment processes
- `payment.succeeded` → Order marked as PAID
- `payment.failed` → Inventory releases stock (compensation)

### 4.7 ✅ Idempotency & Duplicate Prevention

```javascript
// Redis-based idempotency check
const processedKey = `processed:${eventId}`;
const alreadyProcessed = await redisClient.get(processedKey);

if (alreadyProcessed) {
  logger.warn({ eventId }, 'Duplicate message detected, skipping');
  channel.ack(msg);
  return;
}

// Process message...

// Mark as processed with TTL
await redisClient.set(processedKey, '1', { EX: 86400 });
```

### 4.8 ✅ Distributed Tracing

```javascript
// Trace context propagation qua RabbitMQ
const extractedContext = propagation.extract(context.active(), msg.properties.headers);
const span = tracer.startSpan(`consume-${queue}`, {}, extractedContext);

// Inject trace context vào outgoing requests
propagation.inject(context.active(), messageHeaders);
```

**Jaeger UI:** `http://localhost:16686`

---

## 5. Hướng dẫn cài đặt

### 5.1 Prerequisites

- Docker & Docker Compose
- Node.js 18+
- pnpm

### 5.2 Quick Start

```bash
# Clone repository
git clone <repo-url>
cd em-project

# Copy environment file
cp .env.example .env

# Start all services
docker compose up --build

# Hoặc start infrastructure trước
docker compose -f docker-compose.infras.yml up -d
pnpm install
pnpm dev
```

### 5.3 Services & Ports

| Service | Port | URL |
|---------|------|-----|
| API Gateway | 3003 | http://localhost:3003 |
| Auth Service | 3001 | http://localhost:3001 |
| Product Service | 3004 | http://localhost:3004 |
| Order Service | 3002 | http://localhost:3002 |
| Inventory Service | 3005 | http://localhost:3005 |
| Payment Service | 3006 | http://localhost:3006 |
| Seckill Service | 3007 | http://localhost:3007 |
| RabbitMQ Management | 15672 | http://localhost:15672 |
| Jaeger UI | 16686 | http://localhost:16686 |
| Redis | 6379 | - |
| Redis Seckill | 6380 | - |

---

## 6. API Documentation

### 6.1 Auth Service

```bash
# Register
POST /auth/register
{
  "username": "user1",
  "password": "password123"
}

# Login
POST /auth/login
{
  "username": "user1",
  "password": "password123"
}
# Returns: { token: "jwt..." }
```

### 6.2 Product Service

```bash
# Get all products
GET /products

# Create product (requires auth)
POST /products
Authorization: Bearer <token>
{
  "name": "Product 1",
  "price": 100,
  "description": "..."
}
```

### 6.3 Order Service

```bash
# Create order (requires auth)
POST /orders
Authorization: Bearer <token>
{
  "products": [
    { "productId": "...", "quantity": 2 }
  ]
}

# Get order status
GET /orders/:orderId
```

### 6.4 Seckill Service (Flash Sale)

```bash
# Initialize campaign (admin)
POST /admin/seckill/init
X-Admin-Key: <admin-key>
{
  "productId": "flash-product-1",
  "stock": 100,
  "price": 99,
  "startTime": "2024-01-01T00:00:00Z",
  "endTime": "2024-01-02T00:00:00Z"
}

# Buy (requires auth)
POST /seckill/buy
Authorization: Bearer <token>
{
  "productId": "flash-product-1"
}

# Get status
GET /seckill/status/:productId
```

---

## 📊 Kết luận

Nhóm 6 đã cải tiến đáng kể hệ thống e-commerce microservices từ bản gốc:

1. **Kiến trúc**: Event-Driven với Saga Pattern, Outbox Pattern
2. **Hiệu năng**: Async processing, Connection pooling, Caching
3. **Độ tin cậy**: Circuit Breaker, Idempotency, DLQ
4. **Observability**: Distributed Tracing, Structured Logging, Metrics
5. **Nghiệp vụ**: Inventory Management, Payment Service, Flash Sale

Hệ thống đã sẵn sàng cho production với khả năng scale và fault tolerance tốt hơn nhiều so với bản gốc.
