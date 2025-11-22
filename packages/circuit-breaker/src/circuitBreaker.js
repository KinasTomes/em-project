const CircuitBreaker = require('opossum');
const logger = require('@ecommerce/logger');

/**
 * Create a circuit breaker wrapper for axios client
 * @param {string} serviceName - Name of the target service
 * @param {AxiosInstance} axiosInstance - Configured axios instance
 * @param {Object} config - Circuit breaker configuration
 * @returns {CircuitBreaker} Circuit breaker instance
 */
function createCircuitBreaker(serviceName, axiosInstance, config) {
  // Create circuit breaker options
  const options = {
    timeout: config.circuitBreaker.timeout,
    errorThresholdPercentage: config.circuitBreaker.errorThresholdPercentage,
    resetTimeout: config.circuitBreaker.resetTimeout,
    rollingCountTimeout: config.circuitBreaker.rollingCountTimeout,
    rollingCountBuckets: config.circuitBreaker.rollingCountBuckets,
    volumeThreshold: config.circuitBreaker.volumeThreshold,
    capacity: config.circuitBreaker.capacity,
    name: `${serviceName}-circuit-breaker`,
  };

  // The action function that will be wrapped by circuit breaker
  const action = async (requestConfig) => {
    const response = await axiosInstance(requestConfig);
    return response;
  };

  // Create circuit breaker
  const breaker = new CircuitBreaker(action, options);

  // Event: Circuit opened (too many failures)
  breaker.on('open', () => {
    logger.error(
      {
        service: serviceName,
        state: 'OPEN',
        errorThreshold: config.circuitBreaker.errorThresholdPercentage,
      },
      '[CircuitBreaker] Circuit OPENED - Requests will be rejected'
    );
  });

  // Event: Circuit closed (back to normal)
  breaker.on('close', () => {
    logger.info(
      {
        service: serviceName,
        state: 'CLOSED',
      },
      '[CircuitBreaker] Circuit CLOSED - Requests allowed'
    );
  });

  // Event: Circuit half-open (testing if service recovered)
  breaker.on('halfOpen', () => {
    logger.warn(
      {
        service: serviceName,
        state: 'HALF_OPEN',
      },
      '[CircuitBreaker] Circuit HALF-OPEN - Testing service recovery'
    );
  });

  // Event: Request succeeded
  breaker.on('success', (result) => {
    logger.debug(
      {
        service: serviceName,
        status: result?.status,
        url: result?.config?.url,
      },
      '[CircuitBreaker] Request succeeded'
    );
  });

  // Event: Request failed
  breaker.on('failure', (error) => {
    logger.warn(
      {
        service: serviceName,
        error: error.message,
        status: error.response?.status,
      },
      '[CircuitBreaker] Request failed'
    );
  });

  // Event: Request rejected (circuit is open)
  breaker.on('reject', () => {
    logger.error(
      {
        service: serviceName,
        state: breaker.opened ? 'OPEN' : 'UNKNOWN',
      },
      '[CircuitBreaker] Request REJECTED - Circuit is open'
    );
  });

  // Event: Request timeout
  breaker.on('timeout', () => {
    logger.error(
      {
        service: serviceName,
        timeout: config.circuitBreaker.timeout,
      },
      '[CircuitBreaker] Request TIMEOUT'
    );
  });

  // Event: Semaphore locked (too many concurrent requests)
  breaker.on('semaphoreLocked', () => {
    logger.warn(
      {
        service: serviceName,
        capacity: config.circuitBreaker.capacity,
      },
      '[CircuitBreaker] Semaphore LOCKED - Too many concurrent requests'
    );
  });

  return breaker;
}

module.exports = { createCircuitBreaker };
