# Integration Guide: Using Circuit Breaker in Order Service

This guide shows how to integrate `@ecommerce/circuit-breaker` into Order Service to make resilient calls to Product Service.

## Step 1: Install Dependencies

From workspace root:

```bash
npm install
```

This will install all dependencies including `axios`, `axios-retry`, and `opossum`.

## Step 2: Create Product Client

Create a new file `services/order/src/clients/productClient.js`:

```javascript
const { createResilientClient } = require('@ecommerce/circuit-breaker');

/**
 * Resilient HTTP client for Product Service
 * 
 * Features:
 * - 3s timeout per request
 * - 3 automatic retries with exponential backoff
 * - Circuit breaker opens at 50% error rate
 * - Automatic trace ID injection
 */
const productClient = createResilientClient(
  'product-service',
  process.env.PRODUCT_SERVICE_URL || 'http://product:3004',
  {
    timeout: 3000, // 3 seconds
    retry: {
      retries: 3,
    },
    circuitBreaker: {
      errorThresholdPercentage: 50,
      resetTimeout: 30000, // 30 seconds
      volumeThreshold: 10,
    },
  }
);

module.exports = productClient;
```

## Step 3: Update Order Service

Modify `services/order/src/services/orderService.js`:

### Before (Direct axios call):

```javascript
const axios = require('axios');

async validateProducts(productIds, token) {
  const response = await axios.get(
    `${this.productServiceUrl}/api/products`,
    {
      headers: { Authorization: authHeader },
      timeout: 5000,
    }
  );
  // ... rest of code
}
```

### After (Using circuit breaker):

```javascript
const productClient = require('../clients/productClient');

async validateProducts(productIds, token) {
  try {
    const products = await productClient.get('/api/products', {
      headers: {
        Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      },
    });
    
    // ... rest of validation logic
    
    return validProducts;
  } catch (error) {
    // Handle circuit breaker errors gracefully
    if (error.code === 'CIRCUIT_OPEN') {
      logger.error(
        { productIds },
        'Product Service is unavailable (circuit open)'
      );
      throw new Error(
        'Product Service is temporarily unavailable. Please try again later.'
      );
    }
    
    if (error.code === 'TIMEOUT') {
      logger.error(
        { productIds, timeout: 3000 },
        'Product Service request timed out'
      );
      throw new Error(
        'Product Service is taking too long to respond. Please try again.'
      );
    }
    
    // Re-throw other errors
    throw error;
  }
}
```

## Step 4: Add Health Check Endpoint

Add a health check endpoint to monitor circuit breaker status:

```javascript
// services/order/src/routes/healthRoutes.js
const express = require('express');
const router = express.Router();
const productClient = require('../clients/productClient');

router.get('/health/dependencies', (req, res) => {
  const productServiceStats = productClient.getStats();
  
  res.json({
    dependencies: {
      productService: {
        status: productServiceStats.state === 'CLOSED' ? 'healthy' : 'unhealthy',
        circuitState: productServiceStats.state,
        stats: {
          totalRequests: productServiceStats.stats.fires,
          successfulRequests: productServiceStats.stats.successes,
          failedRequests: productServiceStats.stats.failures,
          rejectedRequests: productServiceStats.stats.rejects,
          successRate: productServiceStats.stats.fires > 0
            ? ((productServiceStats.stats.successes / productServiceStats.stats.fires) * 100).toFixed(2) + '%'
            : 'N/A',
        },
      },
    },
  });
});

module.exports = router;
```

Register the route in `services/order/src/app.js`:

```javascript
const healthRoutes = require('./routes/healthRoutes');
app.use('/api', healthRoutes);
```

## Step 5: Add Graceful Shutdown

Update `services/order/src/app.js` to shutdown circuit breaker on exit:

```javascript
const productClient = require('./clients/productClient');

async stop() {
  // ... existing shutdown code
  
  // Shutdown circuit breaker
  productClient.shutdown();
  logger.info('✓ [Order] Circuit breaker shutdown');
}
```

## Step 6: Environment Variables

Add to `.env`:

```env
PRODUCT_SERVICE_URL=http://product:3004
```

## Step 7: Test the Integration

### Test 1: Normal Operation

```bash
curl -X POST http://localhost:3002/api/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "productIds": ["product-1", "product-2"],
    "quantities": [1, 2]
  }'
```

Expected: Order created successfully

### Test 2: Product Service Down

Stop Product Service:

```bash
docker-compose stop product
```

Make request:

```bash
curl -X POST http://localhost:3002/api/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "productIds": ["product-1"],
    "quantities": [1]
  }'
```

Expected after 10+ failed requests:
- Circuit opens
- Requests fail immediately with "Product Service is temporarily unavailable"
- No more retries (circuit is open)

### Test 3: Check Health

```bash
curl http://localhost:3002/api/health/dependencies
```

Expected response:

```json
{
  "dependencies": {
    "productService": {
      "status": "unhealthy",
      "circuitState": "OPEN",
      "stats": {
        "totalRequests": 15,
        "successfulRequests": 0,
        "failedRequests": 10,
        "rejectedRequests": 5,
        "successRate": "0.00%"
      }
    }
  }
}
```

### Test 4: Service Recovery

Start Product Service:

```bash
docker-compose start product
```

Wait 30 seconds (resetTimeout), then make request again.

Expected:
- Circuit transitions to HALF_OPEN
- Test request succeeds
- Circuit closes
- Normal operation resumes

## Monitoring & Observability

### Logs

Circuit breaker logs important events:

```
[INFO] [CircuitBreaker] Creating resilient client { service: 'product-service', ... }
[WARN] [CircuitBreaker] Retrying request (attempt 1/3)
[ERROR] [CircuitBreaker] Circuit OPENED - Requests will be rejected
[INFO] [CircuitBreaker] Circuit CLOSED - Requests allowed
```

### Metrics

Get circuit breaker statistics:

```javascript
const stats = productClient.getStats();
console.log(stats);
```

Output:

```javascript
{
  service: 'product-service',
  state: 'CLOSED',  // or 'OPEN', 'HALF_OPEN'
  stats: {
    fires: 100,        // Total requests
    successes: 95,     // Successful requests
    failures: 5,       // Failed requests
    rejects: 0,        // Rejected (circuit open)
    timeouts: 0,       // Timed out requests
    fallbacks: 0,      // Fallback executions
    semaphoreRejections: 0,  // Rejected due to capacity
    percentiles: {
      0: 45,           // Min latency (ms)
      1: 2500,         // Max latency (ms)
      0.5: 120,        // Median latency (ms)
      0.95: 450,       // 95th percentile
      0.99: 890,       // 99th percentile
    }
  }
}
```

### Distributed Tracing

Circuit breaker automatically injects trace ID from OpenTelemetry context:

```
Request headers:
  x-trace-id: 1234567890abcdef
  x-span-id: abcdef1234567890
```

View traces in Jaeger UI: http://localhost:16686

## Advanced Configuration

### Custom Retry Logic

```javascript
const productClient = createResilientClient(
  'product-service',
  'http://product:3004',
  {
    retry: {
      retries: 5,
      retryDelay: (retryCount) => {
        // Custom backoff: 500ms, 1s, 2s, 4s, 8s
        return Math.min(8000, 500 * Math.pow(2, retryCount));
      },
      retryCondition: (error) => {
        // Retry on network errors, 5xx, and 429 (rate limit)
        return (
          !error.response ||
          error.response.status >= 500 ||
          error.response.status === 429
        );
      },
    },
  }
);
```

### Fallback Strategy

```javascript
async function validateProducts(productIds, token) {
  try {
    return await productClient.get('/api/products', {
      headers: { Authorization: token },
    });
  } catch (error) {
    if (error.code === 'CIRCUIT_OPEN') {
      // Fallback: Use cached data
      logger.warn('Using cached product data (circuit open)');
      return getCachedProducts(productIds);
    }
    throw error;
  }
}

function getCachedProducts(productIds) {
  // Implement caching logic (Redis, in-memory, etc.)
  return productIds.map(id => ({
    _id: id,
    name: 'Product (cached)',
    price: 0,
  }));
}
```

### Multiple Service Clients

```javascript
// services/order/src/clients/index.js
const { createResilientClient } = require('@ecommerce/circuit-breaker');

const productClient = createResilientClient(
  'product-service',
  process.env.PRODUCT_SERVICE_URL || 'http://product:3004'
);

const inventoryClient = createResilientClient(
  'inventory-service',
  process.env.INVENTORY_SERVICE_URL || 'http://inventory:3003'
);

const paymentClient = createResilientClient(
  'payment-service',
  process.env.PAYMENT_SERVICE_URL || 'http://payment:3005'
);

module.exports = {
  productClient,
  inventoryClient,
  paymentClient,
};
```

## Best Practices

1. **Set appropriate timeouts**: Consider network latency and service response time
2. **Don't retry on 4xx errors**: These are client errors and won't succeed on retry
3. **Monitor circuit breaker state**: Alert when circuit opens
4. **Implement fallbacks**: Provide degraded functionality when service is down
5. **Use different clients for different services**: Each service should have its own circuit breaker
6. **Test failure scenarios**: Regularly test how your system behaves when dependencies fail
7. **Log all circuit events**: Track when circuits open/close for debugging

## Troubleshooting

### Circuit opens too frequently

- Increase `errorThresholdPercentage` (e.g., from 50% to 70%)
- Increase `volumeThreshold` (e.g., from 10 to 20)
- Check if downstream service is actually having issues

### Circuit never opens

- Decrease `errorThresholdPercentage` (e.g., from 50% to 30%)
- Decrease `volumeThreshold` (e.g., from 10 to 5)
- Check if errors are being caught and handled before reaching circuit breaker

### Requests timeout too quickly

- Increase `timeout` value
- Check network latency between services
- Optimize downstream service performance

### Too many retries

- Decrease `retries` count
- Adjust `retryDelay` to increase backoff time
- Consider if retries are appropriate for the operation

## References

- [Opossum Circuit Breaker](https://nodeshift.dev/opossum/)
- [Axios Retry](https://github.com/softonic/axios-retry)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Release It! by Michael Nygard](https://pragprog.com/titles/mnee2/release-it-second-edition/)
