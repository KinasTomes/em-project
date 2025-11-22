/**
 * Default configuration for Resilient HTTP Client
 */

const DEFAULT_CONFIG = {
  // Timeout configuration
  timeout: 3000, // 3 seconds hard timeout

  // Retry configuration
  retry: {
    retries: 3, // Number of retry attempts
    retryDelay: (retryCount) => {
      // Exponential backoff: 100ms, 200ms, 400ms, 800ms...
      return Math.min(1000, 100 * Math.pow(2, retryCount));
    },
    retryCondition: (error) => {
      // Retry on network errors or 5xx server errors
      return (
        !error.response ||
        (error.response.status >= 500 && error.response.status <= 599)
      );
    },
    shouldResetTimeout: true, // Reset timeout on each retry
  },

  // Circuit Breaker configuration
  circuitBreaker: {
    timeout: 5000, // CB timeout (should be > axios timeout + retries)
    errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
    resetTimeout: 30000, // Try to close circuit after 30s
    rollingCountTimeout: 10000, // Time window for error calculation (10s)
    rollingCountBuckets: 10, // Number of buckets in rolling window
    volumeThreshold: 10, // Minimum number of requests before CB can open
    capacity: 100, // Max concurrent requests
  },
};

/**
 * Merge user options with defaults
 * @param {Object} userOptions - User provided options
 * @returns {Object} Merged configuration
 */
function mergeConfig(userOptions = {}) {
  return {
    timeout: userOptions.timeout || DEFAULT_CONFIG.timeout,
    retry: {
      ...DEFAULT_CONFIG.retry,
      ...(userOptions.retry || {}),
    },
    circuitBreaker: {
      ...DEFAULT_CONFIG.circuitBreaker,
      ...(userOptions.circuitBreaker || {}),
    },
  };
}

module.exports = {
  DEFAULT_CONFIG,
  mergeConfig,
};
