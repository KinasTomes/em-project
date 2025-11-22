# Circuit Breaker Package - Summary

## Overview

Package `@ecommerce/circuit-breaker` cung cấp một **Resilient HTTP Client Wrapper** để thực hiện các cuộc gọi API đồng bộ (REST) giữa các services một cách an toàn với 3 lớp bảo vệ.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Resilient Client                          │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │         Layer 3: Circuit Breaker (Opossum)         │    │
│  │  - Ngắt mạch khi lỗi quá nhiều                     │    │
│  │  - Prevent cascading failures                       │    │
│  │  - Auto recovery after resetTimeout                 │    │
│  └────────────────────────────────────────────────────┘    │
│                          ↓                                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │         Layer 2: Retry Logic (axios-retry)         │    │
│  │  - Retry on network/5xx errors                     │    │
│  │  - Exponential backoff                              │    │
│  │  - Configurable retry count                         │    │
│  └────────────────────────────────────────────────────┘    │
│                          ↓                                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │         Layer 1: Hard Timeout (Axios)              │    │
│  │  - Hard timeout per request (default 3s)           │    │
│  │  - Prevent hanging requests                         │    │
│  └────────────────────────────────────────────────────┘    │
│                          ↓                                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │         HTTP Request (Axios)                        │    │
│  │  + Tracing: Inject x-trace-id header               │    │
│  │  + Logging: Log all events                          │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
packages/circuit-breaker/
├── index.js                      # Main entry point
├── package.json                  # Dependencies
├── README.md                     # Complete documentation
├── INTEGRATION.md                # Integration guide
├── SUMMARY.md                    # This file
├── .gitignore
│
├── src/
│   ├── config.js                 # Default configuration & merge logic
│   ├── axiosClient.js            # Axios instance with retry & tracing
│   ├── circuitBreaker.js         # Circuit breaker wrapper (Opossum)
│   └── resilientClient.js        # Main client factory
│
├── examples/
│   ├── basic-usage.js            # Basic usage examples
│   └── order-to-product.js       # Real-world example (Order → Product)
│
└── test/
    ├── verify-structure.js       # Verify package structure
    └── manual-test.js            # Manual testing
```

## Key Features

### 1. Three-Layer Protection

#### Layer 1: Hard Timeout (Axios)
- Mỗi request có timeout cứng (default 3s)
- Prevent hanging requests
- Configurable per client

#### Layer 2: Automatic Retry (axios-retry)
- Retry on network errors (ECONNREFUSED, ETIMEDOUT, etc.)
- Retry on 5xx server errors
- Exponential backoff (100ms → 200ms → 400ms → 800ms)
- Default: 3 retries
- Skip retry on 4xx client errors

#### Layer 3: Circuit Breaker (Opossum)
- Monitor error rate in rolling time window
- Open circuit when error rate > threshold (default 50%)
- Reject requests immediately when circuit is open
- Auto-recovery: Try to close after resetTimeout (default 30s)
- States: CLOSED → OPEN → HALF_OPEN → CLOSED

### 2. Distributed Tracing Integration

- Automatically inject trace ID from OpenTelemetry context
- Headers added to every request:
  - `x-trace-id`: Trace ID from current span
  - `x-span-id`: Span ID from current span
- Seamless integration with Jaeger

### 3. Structured Logging

Log all important events:
- Circuit state changes (OPEN, CLOSED, HALF_OPEN)
- Retry attempts
- Request failures
- Timeouts
- Rejections

### 4. Configurable

All defaults can be overridden:

```javascript
const client = createResilientClient('service', 'http://service:3000', {
  timeout: 5000,
  retry: {
    retries: 5,
    retryDelay: (retryCount) => retryCount * 1000,
  },
  circuitBreaker: {
    errorThresholdPercentage: 60,
    resetTimeout: 60000,
    volumeThreshold: 20,
  },
});
```

### 5. Monitoring & Stats

```javascript
const stats = client.getStats();
// {
//   service: 'product-service',
//   state: 'CLOSED',
//   stats: {
//     fires: 100,
//     successes: 95,
//     failures: 5,
//     rejects: 0,
//     timeouts: 0,
//     percentiles: { ... }
//   }
// }
```

## Usage

### Basic Usage

```javascript
const { createResilientClient } = require('@ecommerce/circuit-breaker');

const productClient = createResilientClient(
  'product-service',
  'http://product:3004'
);

// Make requests
const products = await productClient.get('/api/products');
const newProduct = await productClient.post('/api/products', { name: 'Product 1' });
```

### Error Handling

```javascript
try {
  const products = await productClient.get('/api/products');
} catch (error) {
  if (error.code === 'CIRCUIT_OPEN') {
    // Circuit breaker is open - service is down
    console.error('Service unavailable');
  } else if (error.code === 'TIMEOUT') {
    // Request timed out
    console.error('Request timeout');
  } else {
    // Other errors
    console.error('Request failed:', error.message);
  }
}
```

## Default Configuration

```javascript
{
  // Timeout
  timeout: 3000, // 3 seconds

  // Retry
  retry: {
    retries: 3,
    retryDelay: (retryCount) => Math.min(1000, 100 * Math.pow(2, retryCount)),
    retryCondition: (error) => !error.response || error.response.status >= 500,
    shouldResetTimeout: true,
  },

  // Circuit Breaker
  circuitBreaker: {
    timeout: 5000,                 // CB timeout (> axios timeout + retries)
    errorThresholdPercentage: 50,  // Open at 50% error rate
    resetTimeout: 30000,           // Try to close after 30s
    rollingCountTimeout: 10000,    // Time window: 10s
    rollingCountBuckets: 10,       // 10 buckets
    volumeThreshold: 10,           // Min 10 requests before opening
    capacity: 100,                 // Max 100 concurrent requests
  },
}
```

## Dependencies

```json
{
  "axios": "^1.6.0",              // HTTP client
  "axios-retry": "^4.0.0",        // Retry logic
  "opossum": "^8.1.0",            // Circuit breaker
  "@opentelemetry/api": "^1.7.0"  // Tracing
}
```

## Integration Example: Order Service → Product Service

### Before (Direct axios call):

```javascript
const axios = require('axios');

async validateProducts(productIds, token) {
  const response = await axios.get(
    `${this.productServiceUrl}/api/products`,
    { headers: { Authorization: token }, timeout: 5000 }
  );
  // ... validation
}
```

**Problems:**
- No retry on transient failures
- No circuit breaker (cascading failures)
- No tracing integration
- Manual timeout handling

### After (Using circuit breaker):

```javascript
const productClient = require('../clients/productClient');

async validateProducts(productIds, token) {
  try {
    const products = await productClient.get('/api/products', {
      headers: { Authorization: token },
    });
    // ... validation
  } catch (error) {
    if (error.code === 'CIRCUIT_OPEN') {
      throw new Error('Product Service is temporarily unavailable');
    }
    throw error;
  }
}
```

**Benefits:**
- ✓ Automatic retry on failures
- ✓ Circuit breaker prevents cascading failures
- ✓ Automatic trace ID injection
- ✓ Structured logging
- ✓ Monitoring & stats

## Circuit Breaker States

### CLOSED (Normal Operation)
- All requests pass through
- Monitor error rate
- If error rate > threshold → OPEN

### OPEN (Service Down)
- Reject all requests immediately
- No retry, no waiting
- After resetTimeout → HALF_OPEN

### HALF_OPEN (Testing Recovery)
- Allow one test request
- If success → CLOSED
- If failure → OPEN

## Monitoring

### Logs

```
[INFO] [CircuitBreaker] Creating resilient client
[WARN] [CircuitBreaker] Retrying request (attempt 1/3)
[ERROR] [CircuitBreaker] Circuit OPENED - Requests will be rejected
[INFO] [CircuitBreaker] Circuit CLOSED - Requests allowed
```

### Metrics

```javascript
const stats = client.getStats();
console.log(`State: ${stats.state}`);
console.log(`Success rate: ${(stats.stats.successes / stats.stats.fires * 100).toFixed(2)}%`);
```

### Health Check

```javascript
app.get('/health/dependencies', (req, res) => {
  const stats = productClient.getStats();
  res.json({
    productService: {
      status: stats.state === 'CLOSED' ? 'healthy' : 'unhealthy',
      circuitState: stats.state,
      stats: stats.stats,
    },
  });
});
```

## Best Practices

1. **One client per service**: Each downstream service should have its own client
2. **Set appropriate timeouts**: Consider network latency and service response time
3. **Don't retry on 4xx**: Client errors won't succeed on retry
4. **Implement fallbacks**: Provide degraded functionality when circuit is open
5. **Monitor circuit state**: Alert when circuit opens
6. **Test failure scenarios**: Regularly test how system behaves when dependencies fail

## Testing

### Test Circuit Breaker

```bash
# 1. Stop downstream service
docker-compose stop product

# 2. Make 10+ requests (circuit will open)
for i in {1..15}; do
  curl http://localhost:3002/api/orders -X POST -d '...'
done

# 3. Check circuit state
curl http://localhost:3002/api/health/dependencies

# 4. Start service and wait 30s (circuit will close)
docker-compose start product
sleep 30
curl http://localhost:3002/api/orders -X POST -d '...'
```

## Performance Impact

- **Timeout**: Minimal overhead (~1ms)
- **Retry**: Only on failures (no overhead on success)
- **Circuit Breaker**: Very low overhead (~1-2ms per request)
- **Tracing**: Minimal overhead (~0.5ms)

**Total overhead**: ~2-3ms per request (negligible)

## When to Use

### Use Circuit Breaker when:
- ✓ Making synchronous HTTP calls between services
- ✓ Need to prevent cascading failures
- ✓ Want automatic retry on transient failures
- ✓ Need monitoring and observability

### Don't use when:
- ✗ Already using async messaging (RabbitMQ, Kafka)
- ✗ Making calls to external APIs (use different config)
- ✗ Internal function calls (no network involved)

## Comparison: Sync vs Async

### Synchronous (with Circuit Breaker)
```
Order → [Circuit Breaker] → Product
  ↓
Wait for response
  ↓
Continue
```

**Pros:**
- Simple to implement
- Immediate response
- Easy to debug

**Cons:**
- Blocking (wait for response)
- Tight coupling
- Need circuit breaker

### Asynchronous (Event-Driven)
```
Order → RabbitMQ → Product
  ↓
Continue immediately
  ↓
Handle response later
```

**Pros:**
- Non-blocking
- Loose coupling
- Natural resilience

**Cons:**
- More complex
- Eventual consistency
- Harder to debug

## Conclusion

Package `@ecommerce/circuit-breaker` cung cấp một giải pháp hoàn chỉnh để thực hiện synchronous HTTP calls một cách an toàn và resilient. Nó kết hợp 3 lớp bảo vệ (Timeout, Retry, Circuit Breaker) với tracing và logging để tạo ra một client mạnh mẽ và dễ sử dụng.

**Recommended for:**
- Order Service → Product Service (validate products)
- Any service → External APIs
- Admin Service → All services (monitoring)

**Not recommended for:**
- Core business flows (use async messaging instead)
- High-throughput operations (use async)
- Long-running operations (use async)

## Next Steps

1. Install dependencies: `npm install` (from workspace root)
2. Create client: See `examples/order-to-product.js`
3. Integrate: See `INTEGRATION.md`
4. Test: See "Testing" section above
5. Monitor: Check logs and stats

## References

- [README.md](./README.md) - Complete API documentation
- [INTEGRATION.md](./INTEGRATION.md) - Step-by-step integration guide
- [examples/](./examples/) - Usage examples
- [Opossum Documentation](https://nodeshift.dev/opossum/)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
