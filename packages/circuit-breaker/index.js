/**
 * @ecommerce/circuit-breaker
 * 
 * Resilient HTTP Client with Circuit Breaker, Retry, and Timeout
 * 
 * Features:
 * - Hard timeout (default 3s)
 * - Automatic retry with exponential backoff (default 3 retries)
 * - Circuit breaker to prevent cascading failures
 * - Distributed tracing integration (inject trace ID)
 * - Structured logging for all events
 * 
 * Usage:
 * ```javascript
 * const { createResilientClient } = require('@ecommerce/circuit-breaker');
 * 
 * const productClient = createResilientClient(
 *   'product-service',
 *   'http://product:3004',
 *   {
 *     timeout: 5000,
 *     retry: { retries: 5 },
 *     circuitBreaker: { errorThresholdPercentage: 60 }
 *   }
 * );
 * 
 * // Use the client
 * const products = await productClient.get('/api/products');
 * const newProduct = await productClient.post('/api/products', { name: 'Product 1' });
 * 
 * // Get circuit breaker stats
 * console.log(productClient.getStats());
 * ```
 */

const { createResilientClient } = require('./src/resilientClient');
const { DEFAULT_CONFIG } = require('./src/config');

module.exports = {
  createResilientClient,
  DEFAULT_CONFIG,
};
