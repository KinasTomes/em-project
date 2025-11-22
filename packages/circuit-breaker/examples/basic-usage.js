/**
 * Basic usage example of @ecommerce/circuit-breaker
 */

const { createResilientClient } = require('../index');

// Example 1: Simple client with defaults
async function example1() {
  console.log('\n=== Example 1: Basic Usage ===\n');

  const productClient = createResilientClient(
    'product-service',
    'http://product:3004'
  );

  try {
    // GET request
    const products = await productClient.get('/api/products');
    console.log('Products:', products);

    // POST request
    const newProduct = await productClient.post('/api/products', {
      name: 'New Product',
      price: 99.99,
    });
    console.log('Created:', newProduct);

    // GET with query params
    const filtered = await productClient.get('/api/products', {
      params: { category: 'electronics' },
    });
    console.log('Filtered:', filtered);
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Code:', error.code);
  }
}

// Example 2: Custom configuration
async function example2() {
  console.log('\n=== Example 2: Custom Configuration ===\n');

  const inventoryClient = createResilientClient(
    'inventory-service',
    'http://inventory:3003',
    {
      // Longer timeout for slow service
      timeout: 5000,

      // More aggressive retry
      retry: {
        retries: 5,
        retryDelay: (retryCount) => retryCount * 1000, // Linear backoff
      },

      // More sensitive circuit breaker
      circuitBreaker: {
        errorThresholdPercentage: 30, // Open at 30% error rate
        resetTimeout: 60000, // Wait 60s before trying again
        volumeThreshold: 5, // Open after 5 failed requests
      },
    }
  );

  try {
    const inventory = await inventoryClient.get('/api/inventory/product-123');
    console.log('Inventory:', inventory);
  } catch (error) {
    if (error.code === 'CIRCUIT_OPEN') {
      console.error('Circuit breaker is open! Service is down.');
    } else if (error.code === 'TIMEOUT') {
      console.error('Request timed out!');
    } else {
      console.error('Request failed:', error.message);
    }
  }
}

// Example 3: Monitoring circuit breaker stats
async function example3() {
  console.log('\n=== Example 3: Monitoring Stats ===\n');

  const client = createResilientClient(
    'test-service',
    'http://localhost:9999' // Non-existent service
  );

  // Make some requests that will fail
  for (let i = 0; i < 15; i++) {
    try {
      await client.get('/api/test');
    } catch (error) {
      console.log(`Request ${i + 1} failed:`, error.code);
    }

    // Check stats after each request
    const stats = client.getStats();
    console.log(`Stats: State=${stats.state}, Failures=${stats.stats.failures}`);

    // Wait a bit between requests
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Final stats
  const finalStats = client.getStats();
  console.log('\nFinal Stats:', JSON.stringify(finalStats, null, 2));
}

// Example 4: Custom headers and authentication
async function example4() {
  console.log('\n=== Example 4: Custom Headers ===\n');

  const authClient = createResilientClient(
    'auth-service',
    'http://auth:3001'
  );

  try {
    // Request with custom headers
    const user = await authClient.get('/api/user/profile', {
      headers: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        'X-Request-ID': '12345',
      },
    });
    console.log('User:', user);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Example 5: Manual circuit control
async function example5() {
  console.log('\n=== Example 5: Manual Circuit Control ===\n');

  const client = createResilientClient(
    'manual-service',
    'http://localhost:3000'
  );

  // Manually open circuit (for maintenance)
  client.openCircuit();
  console.log('Circuit manually opened');

  try {
    await client.get('/api/test');
  } catch (error) {
    console.log('Request rejected:', error.code); // CIRCUIT_OPEN
  }

  // Manually close circuit
  client.closeCircuit();
  console.log('Circuit manually closed');

  // Cleanup
  client.shutdown();
  console.log('Circuit breaker shutdown');
}

// Run examples
async function main() {
  try {
    // Uncomment the example you want to run
    // await example1();
    // await example2();
    // await example3();
    // await example4();
    await example5();
  } catch (error) {
    console.error('Example failed:', error);
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = {
  example1,
  example2,
  example3,
  example4,
  example5,
};
