/**
 * Resilient HTTP client for Product Service
 * 
 * Uses circuit-breaker package to provide:
 * - Hard timeout (3s)
 * - Automatic retry (3 times with exponential backoff)
 * - Circuit breaker (opens at 50% error rate)
 * - Distributed tracing (auto inject trace ID)
 * - Structured logging
 */

const { createResilientClient } = require('@ecommerce/circuit-breaker');
const logger = require('@ecommerce/logger');

/**
 * Create resilient client for Product Service
 */
const productClient = createResilientClient(
  'product-service',
  process.env.PRODUCT_SERVICE_URL || 'http://product:3004',
  {
    // Timeout configuration
    timeout: 3000, // 3 seconds hard timeout

    // Retry configuration
    retry: {
      retries: 3, // Retry 3 times
      retryDelay: (retryCount) => {
        // Exponential backoff: 100ms, 200ms, 400ms
        return Math.min(1000, 100 * Math.pow(2, retryCount));
      },
    },

    // Circuit Breaker configuration
    circuitBreaker: {
      errorThresholdPercentage: 50, // Open circuit at 50% error rate
      resetTimeout: 30000, // Try to close after 30 seconds
      volumeThreshold: 10, // Min 10 requests before circuit can open
      rollingCountTimeout: 10000, // 10 second rolling window
    },
  }
);

logger.info(
  {
    service: 'product-service',
    baseURL: process.env.PRODUCT_SERVICE_URL || 'http://product:3004',
  },
  '[Order] Product client initialized with circuit breaker'
);

/**
 * Get circuit breaker statistics
 * @returns {Object} Circuit breaker stats
 */
function getProductServiceStats() {
  return productClient.getStats();
}

/**
 * Check if Product Service is healthy
 * @returns {boolean} True if circuit is closed
 */
function isProductServiceHealthy() {
  const stats = productClient.getStats();
  return stats.state === 'CLOSED';
}

module.exports = {
  productClient,
  getProductServiceStats,
  isProductServiceHealthy,
};
