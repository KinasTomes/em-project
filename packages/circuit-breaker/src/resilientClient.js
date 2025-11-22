const { createAxiosClient } = require('./axiosClient');
const { createCircuitBreaker } = require('./circuitBreaker');
const { mergeConfig } = require('./config');
const logger = require('@ecommerce/logger');

/**
 * Create a resilient HTTP client with Circuit Breaker, Retry, and Timeout
 * @param {string} serviceName - Name of the target service (for logging)
 * @param {string} baseURL - Base URL of the target service
 * @param {Object} options - Configuration options
 * @returns {Object} Client with get/post/put/delete methods
 */
function createResilientClient(serviceName, baseURL, options = {}) {
  // Merge user options with defaults
  const config = mergeConfig(options);

  logger.info(
    {
      service: serviceName,
      baseURL,
      timeout: config.timeout,
      retries: config.retry.retries,
      cbTimeout: config.circuitBreaker.timeout,
      cbErrorThreshold: config.circuitBreaker.errorThresholdPercentage,
    },
    '[CircuitBreaker] Creating resilient client'
  );

  // Create axios instance with retry logic
  const axiosInstance = createAxiosClient(serviceName, baseURL, config);

  // Wrap axios with circuit breaker
  const breaker = createCircuitBreaker(serviceName, axiosInstance, config);

  /**
   * Execute request through circuit breaker
   * @param {Object} requestConfig - Axios request configuration
   * @returns {Promise<any>} Response data
   */
  async function executeRequest(requestConfig) {
    try {
      const response = await breaker.fire(requestConfig);
      return response.data;
    } catch (error) {
      // Enhanced error handling
      if (error.code === 'EOPENBREAKER') {
        const cbError = new Error(
          `Circuit breaker is OPEN for ${serviceName}. Service may be down.`
        );
        cbError.code = 'CIRCUIT_OPEN';
        cbError.service = serviceName;
        throw cbError;
      }

      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        const timeoutError = new Error(
          `Request to ${serviceName} timed out after ${config.timeout}ms`
        );
        timeoutError.code = 'TIMEOUT';
        timeoutError.service = serviceName;
        throw timeoutError;
      }

      // Re-throw original error with additional context
      error.service = serviceName;
      throw error;
    }
  }

  // Return client with HTTP methods
  return {
    /**
     * GET request
     * @param {string} url - Request URL (relative to baseURL)
     * @param {Object} config - Additional axios config
     * @returns {Promise<any>} Response data
     */
    async get(url, config = {}) {
      return executeRequest({
        method: 'GET',
        url,
        ...config,
      });
    },

    /**
     * POST request
     * @param {string} url - Request URL (relative to baseURL)
     * @param {any} data - Request body
     * @param {Object} config - Additional axios config
     * @returns {Promise<any>} Response data
     */
    async post(url, data, config = {}) {
      return executeRequest({
        method: 'POST',
        url,
        data,
        ...config,
      });
    },

    /**
     * PUT request
     * @param {string} url - Request URL (relative to baseURL)
     * @param {any} data - Request body
     * @param {Object} config - Additional axios config
     * @returns {Promise<any>} Response data
     */
    async put(url, data, config = {}) {
      return executeRequest({
        method: 'PUT',
        url,
        data,
        ...config,
      });
    },

    /**
     * DELETE request
     * @param {string} url - Request URL (relative to baseURL)
     * @param {Object} config - Additional axios config
     * @returns {Promise<any>} Response data
     */
    async delete(url, config = {}) {
      return executeRequest({
        method: 'DELETE',
        url,
        ...config,
      });
    },

    /**
     * PATCH request
     * @param {string} url - Request URL (relative to baseURL)
     * @param {any} data - Request body
     * @param {Object} config - Additional axios config
     * @returns {Promise<any>} Response data
     */
    async patch(url, data, config = {}) {
      return executeRequest({
        method: 'PATCH',
        url,
        data,
        ...config,
      });
    },

    /**
     * Get circuit breaker stats
     * @returns {Object} Circuit breaker statistics
     */
    getStats() {
      return {
        service: serviceName,
        state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
        stats: breaker.stats,
      };
    },

    /**
     * Manually open the circuit
     */
    openCircuit() {
      breaker.open();
      logger.warn({ service: serviceName }, '[CircuitBreaker] Circuit manually opened');
    },

    /**
     * Manually close the circuit
     */
    closeCircuit() {
      breaker.close();
      logger.info({ service: serviceName }, '[CircuitBreaker] Circuit manually closed');
    },

    /**
     * Shutdown the circuit breaker
     */
    shutdown() {
      breaker.shutdown();
      logger.info({ service: serviceName }, '[CircuitBreaker] Circuit breaker shutdown');
    },
  };
}

module.exports = { createResilientClient };
