# 📊 Metrics Documentation

> E-commerce Microservices Metrics Specification
> 
> Last Updated: 2025-11-30

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Shared Metrics Package](#shared-metrics-package)
3. [Common Metrics (All Services)](#common-metrics-all-services)
4. [Service-Specific Metrics](#service-specific-metrics)
5. [Prometheus Configuration](#prometheus-configuration)
6. [Grafana Dashboards](#grafana-dashboards)

---

## Overview

Tất cả các services trong hệ thống sử dụng [Prometheus](https://prometheus.io/) format để expose metrics qua endpoint `/metrics`. Metrics được collect bởi Prometheus server và visualize bằng Grafana.

### Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Service   │────▶│  Prometheus │────▶│   Grafana   │
│  /metrics   │     │   Server    │     │  Dashboard  │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Naming Convention

Tất cả metrics tuân theo convention:
- **Prefix:** `ecommerce_` cho default metrics, `<service>_` cho business metrics
- **Format:** `snake_case`
- **Labels:** Sử dụng labels để phân biệt dimensions (method, status, route, etc.)

---

## Shared Metrics Package

### Package: `@ecommerce/metrics`

```javascript
// packages/metrics/index.js
const promClient = require('prom-client');

// Collect default metrics với prefix
promClient.collectDefaultMetrics({ prefix: 'ecommerce_' });

// HTTP Request Duration Histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code', 'service'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

// HTTP Request Counter
const httpRequestTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'service']
});

// Active Connections Gauge
const activeConnections = new promClient.Gauge({
  name: 'http_active_connections',
  help: 'Number of active HTTP connections',
  labelNames: ['service']
});

// Middleware
function metricsMiddleware(serviceName) {
  return (req, res, next) => {
    const end = httpRequestDuration.startTimer();
    
    res.on('finish', () => {
      const route = req.route?.path || req.path;
      const labels = {
        method: req.method,
        route,
        status_code: res.statusCode,
        service: serviceName
      };
      
      end(labels);
      httpRequestTotal.inc(labels);
    });
    
    next();
  };
}

// Endpoint handler
async function metricsHandler(req, res) {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
}

module.exports = {
  promClient,
  httpRequestDuration,
  httpRequestTotal,
  activeConnections,
  metricsMiddleware,
  metricsHandler
};
```

### Usage in Services

```javascript
const { metricsMiddleware, metricsHandler } = require('@ecommerce/metrics');

// Add middleware (early in middleware chain)
app.use(metricsMiddleware('order-service'));

// Add endpoint
app.get('/metrics', metricsHandler);
```

---

## Common Metrics (All Services)

Metrics được chia làm 2 loại:
- **Application Metrics**: Implement trong code Node.js, expose qua `/metrics` endpoint
- **Infrastructure Metrics**: Thu thập từ external exporters (MongoDB Exporter, RabbitMQ Plugin)

---

### Application Metrics (Implement trong `@ecommerce/metrics`)

#### Default Process Metrics ✅

Tự động thu thập bởi `prom-client.collectDefaultMetrics()`:

| Metric Name | Type | Description |
|-------------|------|-------------|
| `ecommerce_process_cpu_user_seconds_total` | Counter | Total user CPU time spent |
| `ecommerce_process_cpu_system_seconds_total` | Counter | Total system CPU time spent |
| `ecommerce_process_resident_memory_bytes` | Gauge | Resident memory size in bytes |
| `ecommerce_process_heap_bytes` | Gauge | Process heap size in bytes |
| `ecommerce_nodejs_eventloop_lag_seconds` | Gauge | Event loop lag in seconds |
| `ecommerce_nodejs_active_handles_total` | Gauge | Number of active handles |
| `ecommerce_nodejs_active_requests_total` | Gauge | Number of active requests |

#### HTTP Metrics ✅

Implement trong `metricsMiddleware()`:

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `http_request_duration_seconds` | Histogram | method, route, status_code, service | Request duration |
| `http_requests_total` | Counter | method, route, status_code, service | Total requests |
| `http_active_connections` | Gauge | service | Active connections |

---

### Infrastructure Metrics (External Exporters)

> ⚠️ **Lưu ý:** Các metrics dưới đây KHÔNG implement trong Node.js code.
> Chúng được thu thập từ external exporters chạy riêng.

#### Database Metrics (MongoDB)

**Source:** [MongoDB Exporter](https://github.com/percona/mongodb_exporter) hoặc [mongodb-prometheus-exporter](https://github.com/dcu/mongodb_exporter)

```yaml
# docker-compose.yml
mongodb-exporter:
  image: percona/mongodb_exporter:0.40
  environment:
    - MONGODB_URI=mongodb://mongodb:27017
  ports:
    - "9216:9216"
```

| Metric Name | Type | Description |
|-------------|------|-------------|
| `mongodb_connections` | Gauge | Current connections |
| `mongodb_op_counters_total` | Counter | Operations by type (insert, query, update, delete) |
| `mongodb_mongod_metrics_document_total` | Counter | Document operations |
| `mongodb_mongod_wiredtiger_cache_bytes` | Gauge | WiredTiger cache usage |

#### Message Broker Metrics (RabbitMQ)

**Source:** RabbitMQ built-in Prometheus plugin (port `15692`)

```bash
# Enable plugin trong RabbitMQ
rabbitmq-plugins enable rabbitmq_prometheus
```

```yaml
# docker-compose.yml
rabbitmq:
  image: rabbitmq:3-management
  ports:
    - "5672:5672"
    - "15672:15672"
    - "15692:15692"  # Prometheus metrics
```

| Metric Name | Type | Description |
|-------------|------|-------------|
| `rabbitmq_queue_messages` | Gauge | Messages in queue |
| `rabbitmq_queue_messages_ready` | Gauge | Messages ready for delivery |
| `rabbitmq_queue_consumers` | Gauge | Number of consumers |
| `rabbitmq_channel_messages_published_total` | Counter | Messages published |
| `rabbitmq_channel_messages_delivered_total` | Counter | Messages delivered |

#### Prometheus Scrape Config cho Exporters

```yaml
# prometheus.yml - thêm vào scrape_configs
scrape_configs:
  # ... existing service configs ...

  - job_name: 'mongodb'
    static_configs:
      - targets: ['mongodb-exporter:9216']

  - job_name: 'rabbitmq'
    static_configs:
      - targets: ['rabbitmq:15692']
```

---

## Service-Specific Metrics

### 1. API Gateway ✅ IMPLEMENTED

**File:** `services/api-gateway/metrics.js`

```javascript
// Gateway-specific metrics
const proxyRequestDuration = new promClient.Histogram({
  name: 'gateway_proxy_request_duration_seconds',
  help: 'Duration of proxied requests to downstream services',
  labelNames: ['target_service', 'method', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

const rateLimitHits = new promClient.Counter({
  name: 'gateway_rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['limiter_type', 'path']
});

const authFailures = new promClient.Counter({
  name: 'gateway_auth_failures_total',
  help: 'Total authentication failures',
  labelNames: ['reason']
});
```

| Metric Name | Type | Labels | Status | Description |
|-------------|------|--------|--------|-------------|
| `gateway_proxy_request_duration_seconds` | Histogram | target_service, method, status_code | ✅ | Proxy latency |
| `gateway_proxy_requests_total` | Counter | target_service, method, status_code | ✅ | Total proxy requests |
| `gateway_proxy_errors_total` | Counter | target_service, error_code | ✅ | Proxy errors |
| `gateway_rate_limit_hits_total` | Counter | limiter_type, path | ✅ | Rate limit violations |
| `gateway_auth_failures_total` | Counter | reason | ✅ | Auth failures |
| `gateway_auth_success_total` | Counter | - | ✅ | Auth successes |
| `gateway_upstream_health` | Gauge | service | ✅ | Upstream service health (0/1) |

---

### 2. Auth Service ✅ IMPLEMENTED

**File:** `services/auth/src/metrics.js`

```javascript
const loginAttempts = new promClient.Counter({
  name: 'auth_login_attempts_total',
  help: 'Total login attempts',
  labelNames: ['status'] // success, failed_password, user_not_found
});

const registrations = new promClient.Counter({
  name: 'auth_registrations_total',
  help: 'Total user registrations',
  labelNames: ['status'] // success, failed, duplicate_username
});

const tokenOperations = new promClient.Counter({
  name: 'auth_token_operations_total',
  help: 'Token operations',
  labelNames: ['operation', 'status'] // operation: issue, verify, refresh
});

const activeTokens = new promClient.Gauge({
  name: 'auth_active_tokens',
  help: 'Number of active tokens (approximation)'
});

const passwordHashDuration = new promClient.Histogram({
  name: 'auth_password_hash_duration_seconds',
  help: 'Duration of password hashing operations',
  labelNames: ['operation'], // hash, compare
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

const userCount = new promClient.Gauge({
  name: 'auth_users_total',
  help: 'Total number of registered users'
});
```

| Metric Name | Type | Labels | Status | Description |
|-------------|------|--------|--------|-------------|
| `auth_login_attempts_total` | Counter | status | ✅ | Login attempts |
| `auth_registrations_total` | Counter | status | ✅ | User registrations |
| `auth_token_operations_total` | Counter | operation, status | ✅ | Token operations |
| `auth_active_tokens` | Gauge | - | ✅ | Active tokens count |
| `auth_password_hash_duration_seconds` | Histogram | operation | ✅ | Password hashing time |
| `auth_users_total` | Gauge | - | ✅ | Total registered users |

---

### 3. Product Service ✅ IMPLEMENTED

**File:** `services/product/src/metrics.js`

```javascript
const productOperations = new promClient.Counter({
  name: 'product_operations_total',
  help: 'Product CRUD operations',
  labelNames: ['operation', 'status'] // operation: create, read, update, delete; status: success, failed, not_found
});

const productSearchDuration = new promClient.Histogram({
  name: 'product_search_duration_seconds',
  help: 'Product search/query duration',
  labelNames: ['search_type'], // by_id, by_category, list_all, full_text
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

const totalProducts = new promClient.Gauge({
  name: 'product_total_count',
  help: 'Total number of products in database'
});

const productsByCategory = new promClient.Gauge({
  name: 'product_by_category',
  help: 'Number of products by category',
  labelNames: ['category']
});

const inventorySyncOperations = new promClient.Counter({
  name: 'product_inventory_sync_total',
  help: 'Product-Inventory synchronization operations',
  labelNames: ['operation', 'status']
});

const inventorySyncDuration = new promClient.Histogram({
  name: 'product_inventory_sync_duration_seconds',
  help: 'Duration of inventory sync operations',
  labelNames: ['operation'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});
```

| Metric Name | Type | Labels | Status | Description |
|-------------|------|--------|--------|-------------|
| `product_operations_total` | Counter | operation, status | ✅ | CRUD operations |
| `product_search_duration_seconds` | Histogram | search_type | ✅ | Search latency |
| `product_total_count` | Gauge | - | ✅ | Total products |
| `product_by_category` | Gauge | category | ✅ | Products by category |
| `product_inventory_sync_total` | Counter | operation, status | ✅ | Inventory sync operations |
| `product_inventory_sync_duration_seconds` | Histogram | operation | ✅ | Inventory sync latency |

---

### 4. Order Service ✅ IMPLEMENTED

**File:** `services/order/src/metrics.js`

```javascript
const ordersCreated = new promClient.Counter({
  name: 'order_created_total',
  help: 'Total orders created',
  labelNames: ['status'] // pending, confirmed, failed
});

const orderStateTransitions = new promClient.Counter({
  name: 'order_state_transitions_total',
  help: 'Order state machine transitions',
  labelNames: ['from_state', 'to_state', 'trigger']
});

const orderProcessingDuration = new promClient.Histogram({
  name: 'order_processing_duration_seconds',
  help: 'Time from order creation to final state',
  labelNames: ['final_status'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600]
});

const sagaOperations = new promClient.Counter({
  name: 'order_saga_operations_total',
  help: 'Saga pattern operations',
  labelNames: ['saga_type', 'step', 'status']
});

const circuitBreakerState = new promClient.Gauge({
  name: 'order_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['target_service']
});

const outboxPendingMessages = new promClient.Gauge({
  name: 'order_outbox_pending_messages',
  help: 'Number of pending messages in outbox'
});

const orderValueTotal = new promClient.Counter({
  name: 'order_value_total',
  help: 'Total order value processed',
  labelNames: ['currency', 'status']
});

const eventProcessing = new promClient.Counter({
  name: 'order_event_processing_total',
  help: 'Order event processing operations',
  labelNames: ['event_type', 'status']
});

const productValidationDuration = new promClient.Histogram({
  name: 'order_product_validation_duration_seconds',
  help: 'Duration of product validation calls',
  labelNames: ['status'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5]
});
```

| Metric Name | Type | Labels | Status | Description |
|-------------|------|--------|--------|-------------|
| `order_created_total` | Counter | status | ✅ | Orders created |
| `order_state_transitions_total` | Counter | from_state, to_state, trigger | ✅ | State transitions |
| `order_processing_duration_seconds` | Histogram | final_status | ✅ | Order processing time |
| `order_saga_operations_total` | Counter | saga_type, step, status | ✅ | Saga operations |
| `order_circuit_breaker_state` | Gauge | target_service | ✅ | Circuit breaker state |
| `order_outbox_pending_messages` | Gauge | - | ✅ | Pending outbox messages |
| `order_value_total` | Counter | currency, status | ✅ | Total order value |
| `order_operations_total` | Counter | operation, status | ✅ | CRUD operations |
| `order_event_processing_total` | Counter | event_type, status | ✅ | Event processing |
| `order_event_processing_duration_seconds` | Histogram | event_type | ✅ | Event processing latency |
| `order_product_validation_duration_seconds` | Histogram | status | ✅ | Product validation latency |

---

### 5. Payment Service ✅ IMPLEMENTED

**File:** `services/payment/src/metrics.js`

```javascript
const paymentsProcessed = new promClient.Counter({
  name: 'payment_processed_total',
  help: 'Total payments processed',
  labelNames: ['status', 'payment_method'] // status: SUCCEEDED, FAILED, PENDING, PROCESSING
});

const paymentAmount = new promClient.Counter({
  name: 'payment_amount_total',
  help: 'Total payment amount processed',
  labelNames: ['currency', 'status']
});

const paymentProcessingDuration = new promClient.Histogram({
  name: 'payment_processing_duration_seconds',
  help: 'Payment processing duration',
  labelNames: ['payment_method'],
  buckets: [0.1, 0.5, 1, 2, 5, 10]
});

const refundsProcessed = new promClient.Counter({
  name: 'payment_refunds_total',
  help: 'Total refunds processed',
  labelNames: ['status', 'reason']
});

const paymentRetries = new promClient.Counter({
  name: 'payment_retries_total',
  help: 'Payment retry attempts',
  labelNames: ['attempt_number']
});
```

| Metric Name | Type | Labels | Status | Description |
|-------------|------|--------|--------|-------------|
| `payment_processed_total` | Counter | status, payment_method | ✅ | Payments processed |
| `payment_amount_total` | Counter | currency, status | ✅ | Total payment amount |
| `payment_processing_duration_seconds` | Histogram | payment_method, status | ✅ | Processing time |
| `payment_refunds_total` | Counter | status, reason | ✅ | Refunds |
| `payment_refund_amount_total` | Counter | currency | ✅ | Total refund amount |
| `payment_retries_total` | Counter | attempt_number | ✅ | Retry attempts |
| `payment_gateway_errors_total` | Counter | error_code | ✅ | Gateway errors |
| `payment_event_processing_total` | Counter | event_type, status | ✅ | Event processing |
| `payment_event_processing_duration_seconds` | Histogram | event_type | ✅ | Event processing latency |
| `payment_idempotency_checks_total` | Counter | result | ✅ | Idempotency checks |
| `payment_outbox_pending_messages` | Gauge | - | ✅ | Pending outbox messages |
| `payment_outbox_events_total` | Counter | event_type, status | ✅ | Outbox event operations |

---

### 6. Inventory Service

```javascript
const inventoryOperations = new promClient.Counter({
  name: 'inventory_operations_total',
  help: 'Inventory operations',
  labelNames: ['operation', 'status'] // operation: reserve, release, update
});

const stockLevel = new promClient.Gauge({
  name: 'inventory_stock_level',
  help: 'Current stock level',
  labelNames: ['product_id', 'warehouse']
});

const lowStockAlerts = new promClient.Counter({
  name: 'inventory_low_stock_alerts_total',
  help: 'Low stock alerts triggered',
  labelNames: ['product_id']
});

const reservationDuration = new promClient.Histogram({
  name: 'inventory_reservation_duration_seconds',
  help: 'Time to process reservation',
  labelNames: ['batch_size'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1]
});

const distributedLockOperations = new promClient.Counter({
  name: 'inventory_lock_operations_total',
  help: 'Distributed lock operations',
  labelNames: ['operation', 'status'] // operation: acquire, release
});
```

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `inventory_operations_total` | Counter | operation, status | Inventory operations |
| `inventory_stock_level` | Gauge | product_id, warehouse | Stock levels |
| `inventory_low_stock_alerts_total` | Counter | product_id | Low stock alerts |
| `inventory_reservation_duration_seconds` | Histogram | batch_size | Reservation time |
| `inventory_lock_operations_total` | Counter | operation, status | Lock operations |
| `inventory_audit_log_entries_total` | Counter | action_type | Audit entries |

---

## Prometheus Configuration

### `prometheus.yml`

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'api-gateway'
    static_configs:
      - targets: ['api-gateway:3000']
    metrics_path: /metrics

  - job_name: 'auth-service'
    static_configs:
      - targets: ['auth:3001']
    metrics_path: /metrics

  - job_name: 'product-service'
    static_configs:
      - targets: ['product:3002']
    metrics_path: /metrics

  - job_name: 'order-service'
    static_configs:
      - targets: ['order:3003']
    metrics_path: /metrics

  - job_name: 'payment-service'
    static_configs:
      - targets: ['payment:3004']
    metrics_path: /metrics

  - job_name: 'inventory-service'
    static_configs:
      - targets: ['inventory:3005']
    metrics_path: /metrics

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - 'alerts/*.yml'
```

### Alert Rules Example (`alerts/services.yml`)

```yaml
groups:
  - name: service_alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate on {{ $labels.service }}"
          description: "Error rate is {{ $value | humanizePercentage }}"

      - alert: HighLatency
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High latency on {{ $labels.service }}"
          description: "95th percentile latency is {{ $value }}s"

      - alert: CircuitBreakerOpen
        expr: order_circuit_breaker_state == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Circuit breaker open for {{ $labels.target_service }}"

      - alert: LowInventory
        expr: inventory_stock_level < 10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Low inventory for product {{ $labels.product_id }}"
```

---

## Grafana Dashboards

### Recommended Dashboard Panels

#### 1. Overview Dashboard
- Request rate (all services)
- Error rate by service
- P50, P95, P99 latency
- Active connections

#### 2. Business Metrics Dashboard
- Orders per minute
- Revenue (payment amount)
- Successful vs failed orders
- Top products by orders

#### 3. Infrastructure Dashboard
- CPU/Memory usage
- Event loop lag
- MongoDB connection pool
- RabbitMQ queue depth

#### 4. Alerts Dashboard
- Circuit breaker states
- Rate limit hits
- Auth failures
- Low stock alerts

### Sample Grafana Query (PromQL)

```promql
# Request rate by service
sum(rate(http_requests_total[5m])) by (service)

# Error rate
sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (service) 
/ sum(rate(http_requests_total[5m])) by (service)

# P95 latency
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))

# Orders per minute
sum(rate(order_created_total{status="pending"}[1m])) * 60

# Payment success rate
sum(rate(payment_processed_total{status="success"}[5m])) 
/ sum(rate(payment_processed_total[5m]))
```

---

## Implementation Checklist

- [ ] Create `@ecommerce/metrics` shared package
- [ ] Add `/metrics` endpoint to all services
- [ ] Implement HTTP metrics middleware
- [ ] Add service-specific business metrics
- [ ] Configure Prometheus scraping
- [ ] Create Grafana dashboards
- [ ] Set up alerting rules

---

## References

- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
- [Node.js Prometheus Client](https://github.com/siimon/prom-client)
- [RED Method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
- [USE Method](http://www.brendangregg.com/usemethod.html)
