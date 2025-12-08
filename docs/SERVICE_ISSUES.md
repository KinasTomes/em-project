# 📋 Service Issues & Improvements Tracker

> Generated: 2025-11-29
> Status: 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low

---

## 1. API Gateway ✅

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1.1 | Không có Rate Limiting - dễ bị DDoS | 🔴 Critical | ✅ DONE |
| 1.2 | Không có Authentication tập trung | 🟠 High | ✅ DONE |
| 1.3 | Không có CORS configuration | 🟠 High | ✅ DONE |
| 1.4 | Không có Request Validation | 🟡 Medium | ✅ DONE |
| 1.5 | Hardcoded inventory URL (line 89) | 🟢 Low | ✅ DONE |

**Đã implement:**
- Rate Limiting: `generalLimiter` (100 req/min), `authLimiter` (10 req/min)
- Centralized Auth: JWT verification tại gateway
- CORS: `devCors` và `strictCors` modes
- Request Validation: Content-Type, URL length, Request ID
- Config: Sử dụng `config.inventoryServiceUrl`

---

## 2. Auth Service 🟠

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 2.1 | JWT không có expiration time | 🔴 Critical | ✅ DONE |
| 2.2 | Không có password strength validation | 🟠 High | ⬜ TODO |
| 2.3 | Không có refresh token mechanism | 🟠 High | ⬜ TODO |
| 2.4 | Không có rate limiting cho login (brute force) | 🟠 High | ⬜ TODO |
| 2.5 | Dùng console.log thay vì logger | 🟡 Medium | ✅ DONE |
| 2.6 | Không có graceful shutdown | 🟡 Medium | ✅ DONE |

**Code cần fix:**
```javascript
// File: services/auth/src/services/authService.js
// ❌ Hiện tại:
const token = jwt.sign({ id: user._id }, config.jwtSecret);

// ✅ Nên sửa:
const token = jwt.sign(
  { id: user._id, username: user.username },
  config.jwtSecret,
  { expiresIn: '24h' }
);
```

---

## 3. Product Service 🟠

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 3.1 | Constructor gọi async không await | 🔴 Critical | ✅ DONE |
| 3.2 | Không publish events khi CRUD product | 🟠 High | ⬜ TODO |
| 3.3 | Dùng console.log thay vì logger | 🟡 Medium | ✅ DONE |
| 3.4 | Không có graceful shutdown | 🟡 Medium | ✅ DONE |
| 3.5 | Thiếu health check endpoint | 🟡 Medium | ✅ DONE |

**Code cần fix:**
```javascript
// File: services/product/src/app.js
// ❌ Hiện tại:
constructor() {
  this.app = express()
  this.connectDB()  // Async không await!
  this.setMiddlewares()
  this.setRoutes()
}

// ✅ Nên sửa: Dùng pattern như Order/Payment service
async start() {
  await this.connectDB()
  this.setMiddlewares()
  this.setRoutes()
  // ...
}
```

---

## 4. Order Service ✅

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 4.1 | Thiếu endpoint GET /orders (list by user) | 🟡 Medium | ✅ DONE |
| 4.2 | Deprecated Mongoose options | 🟢 Low | ✅ DONE |

**Note:** Service này đã implement tốt: Circuit Breaker, Outbox Pattern, State Machine, Idempotency.

---

## 5. Payment Service ✅

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 5.1 | Thiếu retry với exponential backoff | 🟡 Medium | ✅ DONE |
| 5.2 | Thiếu payment gateway abstraction | 🟡 Medium | ⏭️ SKIP (mock only) |

**Note:** Service này đã implement tốt: Outbox Pattern, Idempotency, Error History, Retry with Exponential Backoff.

---

## 6. Inventory Service ✅

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 6.1 | Potential race condition trong batch reserve | 🟠 High | ✅ DONE |
| 6.2 | Thiếu distributed lock (Redis) | 🟠 High | ✅ DONE |
| 6.3 | Thiếu audit log cho inventory changes | 🟡 Medium | ✅ DONE |

---

## 7. Cross-cutting Issues 🔴

| # | Issue | Services | Severity | Status |
|---|-------|----------|----------|--------|
| 7.1 | Thiếu Health Check chuẩn (/health) | Auth, Product | 🟠 High | ⬜ TODO |
| 7.2 | Thiếu Graceful Shutdown | Auth, Product | 🟠 High | ⬜ TODO |
| 7.3 | Inconsistent Error Response Format | All | 🟡 Medium | ⬜ TODO |
| 7.4 | Thiếu Request ID propagation | API Gateway | 🟡 Medium | ⬜ TODO |
| 7.5 | Thiếu Input Validation (Joi/Zod) | Auth, Product | 🟠 High | ⬜ TODO |
| 7.6 | Deprecated Mongoose options | Order, Auth, Product | 🟢 Low | ⬜ TODO |
| 7.7 | **Thiếu Metrics Endpoint (/metrics)** | All Services | 🟠 High | ⬜ TODO |

---

## 8. Metrics Endpoint 🟠 (NEW)

> **Note:** PLAN.md tuần 5 có đề cập custom metrics cho Saga nhưng chưa có endpoint `/metrics` chuẩn cho từng service.

| # | Issue | Services | Severity | Status |
|---|-------|----------|----------|--------|
| 8.1 | Thiếu `/metrics` endpoint (Prometheus format) | All | 🟠 High | ⬜ TODO |
| 8.2 | Thiếu default metrics (CPU, Memory, Event Loop) | All | 🟡 Medium | ⬜ TODO |
| 8.3 | Thiếu HTTP request metrics (duration, count) | All | 🟠 High | ⬜ TODO |
| 8.4 | Thiếu business metrics (orders/min, payments/min) | Order, Payment | 🟡 Medium | ⬜ TODO |

**Implementation Guide:**

```javascript
// packages/metrics/index.js (tạo shared package)
const promClient = require('prom-client');

// Collect default metrics (CPU, Memory, Event Loop lag)
promClient.collectDefaultMetrics({ prefix: 'ecommerce_' });

// HTTP request duration histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

// Middleware
function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route?.path || req.path, status_code: res.statusCode });
  });
  next();
}

// Endpoint handler
async function metricsHandler(req, res) {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
}

module.exports = { promClient, httpRequestDuration, metricsMiddleware, metricsHandler };
```

**Usage in each service:**
```javascript
// services/order/src/app.js
const { metricsMiddleware, metricsHandler } = require('@ecommerce/metrics');

// Add middleware
this.app.use(metricsMiddleware);

// Add endpoint
this.app.get('/metrics', metricsHandler);
```

**Custom Business Metrics (Order Service):**
```javascript
const ordersCreated = new promClient.Counter({
  name: 'orders_created_total',
  help: 'Total number of orders created',
  labelNames: ['status']
});

// In orderService.createOrder()
ordersCreated.inc({ status: 'pending' });
```

---

## 📊 Summary

| Service | Critical | High | Medium | Low | Total |
|---------|----------|------|--------|-----|-------|
| API Gateway | 1 | 2 | 1 | 1 | **5** |
| Auth | 1 | 3 | 2 | 0 | **6** |
| Product | 1 | 1 | 3 | 0 | **5** |
| Order | 0 | 0 | 1 | 1 | **2** |
| Payment | 0 | 0 | 2 | 0 | **2** |
| Inventory | 0 | 2 | 1 | 0 | **3** |
| Cross-cutting | 0 | 4 | 2 | 1 | **7** |
| Metrics | 0 | 2 | 2 | 0 | **4** |
| **TOTAL** | **3** | **14** | **14** | **3** | **34** |

---

## 🎯 Priority Fix Order

### Phase 1: Security (Critical)
1. [ ] Auth: JWT expiration
2. [ ] API Gateway: Rate limiting
3. [x] Product: Fix async constructor ✅

### Phase 2: Reliability (High)
4. [ ] API Gateway: CORS
5. [ ] Auth: Password validation
6. [ ] Auth/Product: Graceful shutdown
7. [ ] All: Health check endpoints
8. [ ] Inventory: Distributed lock
9. [ ] **All: Metrics endpoint (/metrics)** ← NEW

### Phase 3: Quality (Medium)
10. [ ] All: Standardize error responses
11. [ ] API Gateway: Request ID propagation
12. [ ] Auth/Product: Input validation
13. [ ] Order: List orders endpoint
14. [ ] All: HTTP request metrics
15. [ ] Order/Payment: Business metrics

---

## 📝 Notes

- Order và Payment service đã được implement tốt với các patterns: Outbox, Idempotency, Circuit Breaker
- Cần chuẩn hóa các service khác theo pattern của Order/Payment
- Xem xét thêm OpenTelemetry tracing cho tất cả services
