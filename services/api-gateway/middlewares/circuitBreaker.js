/**
 * Circuit Breaker Middleware for API Gateway
 * 
 * Implements Circuit Breaker pattern for each upstream service.
 * Prevents cascading failures when a service is down.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is down, requests fail fast (503)
 * - HALF_OPEN: Testing if service recovered
 */

const CircuitBreaker = require('opossum');
const logger = require('@ecommerce/logger');

// Circuit Breaker instances per service
const circuitBreakers = new Map();

// Default configuration
const DEFAULT_OPTIONS = {
  timeout: 10000,                    // 10s timeout for proxy requests
  errorThresholdPercentage: 50,      // Open circuit if 50% fail
  resetTimeout: 30000,               // Try again after 30s
  volumeThreshold: 10,               // Min requests before CB can trip
  rollingCountTimeout: 10000,        // 10s rolling window
  rollingCountBuckets: 10,
};

/**
 * Create or get existing circuit breaker for a service
 * @param {string} serviceName - Name of the upstream service
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker}
 */
function getCircuitBreaker(serviceName, options = {}) {
  if (circuitBreakers.has(serviceName)) {
    return circuitBreakers.get(serviceName);
  }

  const cbOptions = { ...DEFAULT_OPTIONS, ...options, name: `${serviceName}-cb` };

  // The action is a simple pass-through that we'll use to track success/failure
  // The actual proxy happens outside, we just use CB for state management
  const action = async (proxyFn) => {
    return await proxyFn();
  };

  const breaker = new CircuitBreaker(action, cbOptions);

  // Event handlers
  breaker.on('open', () => {
    logger.error(
      { service: serviceName, state: 'OPEN' },
      `🔴 [CircuitBreaker] ${serviceName} circuit OPENED - Requests will fail fast`
    );
  });

  breaker.on('close', () => {
    logger.info(
      { service: serviceName, state: 'CLOSED' },
      `🟢 [CircuitBreaker] ${serviceName} circuit CLOSED - Service recovered`
    );
  });

  breaker.on('halfOpen', () => {
    logger.warn(
      { service: serviceName, state: 'HALF_OPEN' },
      `🟡 [CircuitBreaker] ${serviceName} circuit HALF-OPEN - Testing recovery`
    );
  });

  breaker.on('reject', () => {
    logger.warn(
      { service: serviceName },
      `⚡ [CircuitBreaker] ${serviceName} request REJECTED (circuit open)`
    );
  });

  breaker.on('timeout', () => {
    logger.warn(
      { service: serviceName, timeout: cbOptions.timeout },
      `⏱️ [CircuitBreaker] ${serviceName} request TIMEOUT`
    );
  });

  circuitBreakers.set(serviceName, breaker);
  logger.info(
    { service: serviceName, options: cbOptions },
    `✓ [CircuitBreaker] Created circuit breaker for ${serviceName}`
  );

  return breaker;
}

/**
 * Get circuit breaker state for a service
 * @param {string} serviceName 
 * @returns {string} 'CLOSED' | 'OPEN' | 'HALF_OPEN'
 */
function getCircuitState(serviceName) {
  const breaker = circuitBreakers.get(serviceName);
  if (!breaker) return 'UNKNOWN';
  if (breaker.opened) return 'OPEN';
  if (breaker.halfOpen) return 'HALF_OPEN';
  return 'CLOSED';
}

/**
 * Get all circuit breaker stats
 * @returns {Object} Stats for all services
 */
function getAllCircuitStats() {
  const stats = {};
  for (const [name, breaker] of circuitBreakers) {
    stats[name] = {
      state: getCircuitState(name),
      stats: breaker.stats,
    };
  }
  return stats;
}

/**
 * Record a successful request for a service
 * @param {string} serviceName 
 */
function recordSuccess(serviceName) {
  const breaker = circuitBreakers.get(serviceName);
  if (breaker) {
    // Fire a successful action to update stats
    breaker.fire(() => Promise.resolve()).catch(() => {});
  }
}

/**
 * Record a failed request for a service
 * @param {string} serviceName 
 * @param {Error} error 
 */
function recordFailure(serviceName, error) {
  const breaker = circuitBreakers.get(serviceName);
  if (breaker) {
    // Fire a failing action to update stats
    breaker.fire(() => Promise.reject(error)).catch(() => {});
  }
}

/**
 * Check if circuit is open (should fail fast)
 * @param {string} serviceName 
 * @returns {boolean}
 */
function isCircuitOpen(serviceName) {
  const breaker = circuitBreakers.get(serviceName);
  return breaker ? breaker.opened : false;
}

/**
 * Middleware factory for circuit breaker protection
 * @param {string} serviceName - Name of the upstream service
 * @param {Object} options - Circuit breaker options
 * @returns {Function} Express middleware
 */
function circuitBreakerMiddleware(serviceName, options = {}) {
  // Initialize circuit breaker for this service
  getCircuitBreaker(serviceName, options);

  return (req, res, next) => {
    // Check if circuit is open
    if (isCircuitOpen(serviceName)) {
      logger.warn(
        { service: serviceName, path: req.path, method: req.method },
        `⚡ [CircuitBreaker] Fast-fail: ${serviceName} circuit is OPEN`
      );

      return res.status(503).json({
        error: 'Service Unavailable',
        message: `${serviceName} service is temporarily unavailable. Please try again later.`,
        circuitState: 'OPEN',
        retryAfter: 30, // seconds
      });
    }

    // Store service name for later use in proxy handlers
    req.circuitBreakerService = serviceName;
    next();
  };
}

module.exports = {
  circuitBreakerMiddleware,
  getCircuitBreaker,
  getCircuitState,
  getAllCircuitStats,
  recordSuccess,
  recordFailure,
  isCircuitOpen,
};
