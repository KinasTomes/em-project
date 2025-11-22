# @ecommerce/circuit-breaker

Resilient HTTP Client Wrapper with Circuit Breaker, Retry, and Timeout protection.

## Features

### 3-Layer Protection

1. **Hard Timeout**: Every request has a hard timeout (default 3s)
2. **Automatic Retry**: Retry on network errors or 5xx errors with exponential backoff
3. **Circuit Breaker**: Prevent cascading failures by opening circuit when error rate is high

### Additional Features

- **Distributed Tracing**: Automatically inject trace ID from OpenTelemetry context
- **Structured Logging**: Log all important events (CB state changes, retries, failures)
- **Configurable**: Override all default values
- **Stats & Monitoring**: Get circuit breaker statistics

## Installation

```bash
npm install @ecommerce/circuit-breaker
```

## Usage

### Basic Usage

```javascript
const { createResilientClient } = require('@ecommerce/circuit-breaker');

// Create a client for Product Service
const productClient = createResilientClient(
  'product-service',           // Service name (for logging)
  'http://product:3004'         // Base URL
);

// Make requests
try {
  const products = await productClient.get('/api/products');
  console.log(products);
} catch (error) {
  if (error.code === 'CIRCUIT_OPEN') {
    console.error('Circuit breaker is open!');
  } else if (error.code === 'TIMEOUT') {
    console.error('Request timed out!');
  } else {
    console.error('Request failed:', error.message);
  }
}
```

### Custom Configuration

```javascript
const client = createResilientClient(
  'inventory-service',
  'http://inventory:3003',
  {
    // Timeout configuration
    timeout: 5000, // 5 seconds

    // Retry configuration
    retry: {
      retries: 5,
      retryDelay: (retryCount) => retryCount * 1000, // Linear backoff
    },

    // Circuit Breaker configuration
    circuitBreaker: {
      timeout: 10000,                  // CB timeout
      errorThresholdPercentage: 60,    // Open at 60% error rate
      resetTimeout: 60000,             // Try to close after 60s
      volumeThreshold: 5,              // Min 5 requests before opening
    },
  }
);
```

### All HTTP Methods

```javascript
// GET
const data = await client.get('/api/resource');

// POST
const created = await client.post('/api/resource', { name: 'New Item' });

// PUT
const updated = await client.put('/api/resource/123', { name: 'Updated' });

// PATCH
const patched = await client.patch('/api/resource/123', { status: 'active' });

// DELETE
await client.delete('/api/resource/123');
```

### Custom Headers & Config

```javascript
const data = await client.get('/api/protected', {
  headers: {
    'Authorization': 'Bearer token123',
    'X-Custom-Header': 'value',
  },
  params: {
    page: 1,
    limit: 10,
  },
});
```

### Monitoring & Stats

```javascript
// Get circuit breaker statistics
const stats = client.getStats();
console.log(stats);
// {
//   service: 'product-service',
//   state: 'CLOSED',  // or 'OPEN', 'HALF_OPEN'
//   stats: {
//     fires: 100,
//     successes: 95,
//     failures: 5,
//     rejects: 0,
//     timeouts: 0,
//     ...
//   }
// }

// Manually control circuit
client.openCircuit();   // Force open
client.closeCircuit();  // Force close
client.shutdown();      // Cleanup
```

## Configuration Options

### Default Configuration

```javascript
{
  // Hard timeout for each request
  timeout: 3000, // 3 seconds

  // Retry configuration
  retry: {
    retries: 3,                    // Number of retry attempts
    retryDelay: (retryCount) => {  // Exponential backoff
      return Math.min(1000, 100 * Math.pow(2, retryCount));
    },
    retryCondition: (error) => {   // Retry on network/5xx errors
      return !error.response || 
             (error.response.status >= 500 && error.response.status <= 599);
    },
    shouldResetTimeout: true,      // Reset timeout on each retry
  },

  // Circuit Breaker configuration
  circuitBreaker: {
    timeout: 5000,                 // CB timeout (> axios timeout + retries)
    errorThresholdPercentage: 50,  // Open at 50% error rate
    resetTimeout: 30000,           // Try to close after 30s
    rollingCountTimeout: 10000,    // Time window for error calculation
    rollingCountBuckets: 10,       // Number of buckets in rolling window
    volumeThreshold: 10,           // Min requests before CB can open
    capacity: 100,                 // Max concurrent requests
  },
}
```

## Error Handling

The client throws enhanced errors with additional context:

```javascript
try {
  await client.get('/api/resource');
} catch (error) {
  console.log(error.code);     // 'CIRCUIT_OPEN', 'TIMEOUT', etc.
  console.log(error.service);  // 'product-service'
  console.log(error.message);  // Descriptive error message
}
```

### Error Codes

- `CIRCUIT_OPEN`: Circuit breaker is open (service may be down)
- `TIMEOUT`: Request timed out
- `ECONNREFUSED`: Connection refused (service not available)
- `ENOTFOUND`: DNS lookup failed (invalid hostname)

## Integration with Tracing

The client automatically injects trace ID from OpenTelemetry context:

```javascript
// Headers automatically added to every request:
{
  'x-trace-id': '1234567890abcdef',
  'x-span-id': 'abcdef1234567890'
}
```

## Logging

All important events are logged using `@ecommerce/logger`:

- Circuit state changes (OPEN, CLOSED, HALF_OPEN)
- Retry attempts
- Request failures
- Timeouts
- Rejections

## Best Practices

1. **Set appropriate timeouts**: Consider network latency and service response time
2. **Configure retry wisely**: Too many retries can amplify load on failing service
3. **Monitor circuit breaker stats**: Track error rates and circuit state
4. **Handle errors gracefully**: Always catch and handle circuit breaker errors
5. **Use different clients for different services**: Each service should have its own client

## Example: Order Service calling Product Service

```javascript
// services/order/src/clients/productClient.js
const { createResilientClient } = require('@ecommerce/circuit-breaker');

const productClient = createResilientClient(
  'product-service',
  process.env.PRODUCT_SERVICE_URL || 'http://product:3004',
  {
    timeout: 3000,
    retry: { retries: 3 },
    circuitBreaker: {
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    },
  }
);

module.exports = productClient;
```

```javascript
// services/order/src/services/orderService.js
const productClient = require('../clients/productClient');

async function validateProducts(productIds) {
  try {
    const products = await productClient.get('/api/products');
    // ... validation logic
  } catch (error) {
    if (error.code === 'CIRCUIT_OPEN') {
      throw new Error('Product service is currently unavailable');
    }
    throw error;
  }
}
```

## License

MIT
