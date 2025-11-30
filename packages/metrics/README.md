# @ecommerce/metrics

Shared Prometheus metrics package for ecommerce microservices.

## Installation

```bash
pnpm add @ecommerce/metrics
```

## Features

- ✅ Default process metrics (CPU, Memory, Event Loop)
- ✅ HTTP request duration histogram
- ✅ HTTP request counter
- ✅ Active connections gauge
- ✅ Route normalization (prevents high cardinality)
- ✅ Custom metric factories

## Quick Start

```javascript
const express = require('express');
const { metricsMiddleware, metricsHandler } = require('@ecommerce/metrics');

const app = express();

// Add metrics middleware (place early in middleware chain)
app.use(metricsMiddleware('my-service'));

// Add metrics endpoint
app.get('/metrics', metricsHandler);

app.listen(3000);
```

## HTTP Metrics Collected

| Metric | Type | Description |
|--------|------|-------------|
| `http_request_duration_seconds` | Histogram | Request duration in seconds |
| `http_requests_total` | Counter | Total HTTP requests |
| `http_active_connections` | Gauge | Currently active connections |

### Labels

All HTTP metrics include these labels:
- `method` - HTTP method (GET, POST, etc.)
- `route` - Normalized route path (e.g., `/orders/:id`)
- `status_code` - HTTP status code
- `service` - Service name

## Route Normalization

The middleware automatically normalizes routes to prevent high cardinality issues:

```
/orders/507f1f77bcf86cd799439011 → /orders/:id
/users/123/orders/456           → /users/:id/orders/:id
/products?page=1&limit=10       → /products
```

## Custom Business Metrics

Use the factory functions to create service-specific metrics:

```javascript
const { createCounter, createHistogram, createGauge } = require('@ecommerce/metrics');

// Counter - for counting events
const ordersCreated = createCounter({
  name: 'orders_created_total',
  help: 'Total number of orders created',
  labelNames: ['status']
});

// Increment counter
ordersCreated.inc({ status: 'pending' });

// Histogram - for measuring distributions
const processingTime = createHistogram({
  name: 'order_processing_seconds',
  help: 'Order processing time',
  labelNames: ['type'],
  buckets: [0.1, 0.5, 1, 2, 5]
});

// Time an operation
const end = processingTime.startTimer();
await processOrder();
end({ type: 'standard' });

// Gauge - for current values
const queueSize = createGauge({
  name: 'order_queue_size',
  help: 'Current order queue size'
});

// Set value
queueSize.set(42);
queueSize.inc();
queueSize.dec();
```

## Default Process Metrics

The package automatically collects Node.js process metrics with `ecommerce_` prefix:

- `ecommerce_process_cpu_user_seconds_total`
- `ecommerce_process_cpu_system_seconds_total`
- `ecommerce_process_resident_memory_bytes`
- `ecommerce_nodejs_eventloop_lag_seconds`
- `ecommerce_nodejs_active_handles_total`
- And more...

## API Reference

### `metricsMiddleware(serviceName)`

Express middleware that collects HTTP metrics.

```javascript
app.use(metricsMiddleware('order-service'));
```

### `metricsHandler(req, res)`

Express handler for `/metrics` endpoint.

```javascript
app.get('/metrics', metricsHandler);
```

### `createCounter(options)`

Create a custom Counter metric.

### `createGauge(options)`

Create a custom Gauge metric.

### `createHistogram(options)`

Create a custom Histogram metric.

### `createSummary(options)`

Create a custom Summary metric.

### `register`

The Prometheus registry instance (for advanced usage).

### `promClient`

The prom-client library instance (for advanced usage).

## Prometheus Configuration

```yaml
scrape_configs:
  - job_name: 'my-service'
    static_configs:
      - targets: ['my-service:3000']
    metrics_path: /metrics
    scrape_interval: 15s
```

## Best Practices

1. **Place middleware early** - Add `metricsMiddleware` before route handlers
2. **Use consistent service names** - Same name in middleware and Prometheus config
3. **Avoid high cardinality** - Don't add user IDs or request IDs as labels
4. **Use appropriate buckets** - Customize histogram buckets for your use case
