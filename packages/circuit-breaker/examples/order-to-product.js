/**
 * Real-world example: Order Service calling Product Service
 * 
 * This example shows how to use circuit-breaker in Order Service
 * to make resilient calls to Product Service
 */

const { createResilientClient } = require('../index');

// Create a resilient client for Product Service
const productClient = createResilientClient(
  'product-service',
  process.env.PRODUCT_SERVICE_URL || 'http://product:3004',
  {
    timeout: 3000, // 3 seconds timeout
    retry: {
      retries: 3, // Retry 3 times
    },
    circuitBreaker: {
      errorThresholdPercentage: 50, // Open at 50% error rate
      resetTimeout: 30000, // Try to close after 30s
      volumeThreshold: 10, // Min 10 requests before opening
    },
  }
);

/**
 * Validate products by calling Product Service
 * @param {string[]} productIds - Array of product IDs
 * @param {string} token - JWT token for authentication
 * @returns {Promise<Object[]>} Array of valid products
 */
async function validateProducts(productIds, token) {
  try {
    // Make resilient GET request to Product Service
    const products = await productClient.get('/api/products', {
      headers: {
        Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      },
    });

    // Filter products that match requested IDs
    const validProducts = products.filter((product) =>
      productIds.includes(product._id.toString())
    );

    if (validProducts.length !== productIds.length) {
      const foundIds = validProducts.map((p) => p._id.toString());
      const missingIds = productIds.filter((id) => !foundIds.includes(id));
      throw new Error(`Products not found: ${missingIds.join(', ')}`);
    }

    return validProducts;
  } catch (error) {
    // Handle circuit breaker errors
    if (error.code === 'CIRCUIT_OPEN') {
      throw new Error(
        'Product Service is currently unavailable. Please try again later.'
      );
    }

    if (error.code === 'TIMEOUT') {
      throw new Error(
        'Product Service is taking too long to respond. Please try again.'
      );
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Get product details by ID
 * @param {string} productId - Product ID
 * @param {string} token - JWT token
 * @returns {Promise<Object>} Product details
 */
async function getProductById(productId, token) {
  try {
    const product = await productClient.get(`/api/products/${productId}`, {
      headers: {
        Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      },
    });

    return product;
  } catch (error) {
    if (error.code === 'CIRCUIT_OPEN') {
      // Return cached data or default values when circuit is open
      console.warn('Circuit is open, returning cached data');
      return getCachedProduct(productId);
    }

    throw error;
  }
}

/**
 * Get cached product (fallback when Product Service is down)
 * @param {string} productId - Product ID
 * @returns {Object} Cached product or default
 */
function getCachedProduct(productId) {
  // In real implementation, this would fetch from Redis or local cache
  return {
    _id: productId,
    name: 'Product (cached)',
    price: 0,
    available: false,
  };
}

/**
 * Monitor Product Service health
 * @returns {Object} Health status and circuit breaker stats
 */
function getProductServiceHealth() {
  const stats = productClient.getStats();
  
  return {
    service: stats.service,
    status: stats.state === 'CLOSED' ? 'healthy' : 'unhealthy',
    circuitState: stats.state,
    stats: {
      totalRequests: stats.stats.fires,
      successfulRequests: stats.stats.successes,
      failedRequests: stats.stats.failures,
      rejectedRequests: stats.stats.rejects,
      timeouts: stats.stats.timeouts,
      successRate: stats.stats.fires > 0
        ? ((stats.stats.successes / stats.stats.fires) * 100).toFixed(2) + '%'
        : 'N/A',
    },
  };
}

// Example usage
async function example() {
  try {
    // Validate products for an order
    const productIds = ['product-1', 'product-2', 'product-3'];
    const token = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';

    console.log('Validating products...');
    const validProducts = await validateProducts(productIds, token);
    console.log('Valid products:', validProducts);

    // Get single product
    console.log('\nGetting product details...');
    const product = await getProductById('product-1', token);
    console.log('Product:', product);

    // Check health
    console.log('\nProduct Service health:');
    const health = getProductServiceHealth();
    console.log(JSON.stringify(health, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Export for use in Order Service
module.exports = {
  productClient,
  validateProducts,
  getProductById,
  getProductServiceHealth,
};

// Run example if executed directly
if (require.main === module) {
  example();
}
