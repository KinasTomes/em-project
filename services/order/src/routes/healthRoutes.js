const express = require('express');
const router = express.Router();
const {
  productClient,
  getProductServiceStats,
  isProductServiceHealthy,
} = require('../clients/productClient');

/**
 * Health check endpoint
 * GET /api/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'order-service',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Dependencies health check
 * GET /api/health/dependencies
 * 
 * Returns circuit breaker status for all downstream services
 */
router.get('/health/dependencies', (req, res) => {
  const productStats = getProductServiceStats();
  
  const isHealthy = productStats.state === 'CLOSED';
  const successRate = productStats.stats.fires > 0
    ? ((productStats.stats.successes / productStats.stats.fires) * 100).toFixed(2)
    : 'N/A';

  res.json({
    status: isHealthy ? 'healthy' : 'degraded',
    dependencies: {
      productService: {
        status: isHealthy ? 'healthy' : 'unhealthy',
        circuitState: productStats.state,
        stats: {
          totalRequests: productStats.stats.fires,
          successfulRequests: productStats.stats.successes,
          failedRequests: productStats.stats.failures,
          rejectedRequests: productStats.stats.rejects,
          timeouts: productStats.stats.timeouts,
          successRate: successRate + '%',
        },
        latency: productStats.stats.percentiles
          ? {
              min: productStats.stats.percentiles['0'] + 'ms',
              median: productStats.stats.percentiles['0.5'] + 'ms',
              p95: productStats.stats.percentiles['0.95'] + 'ms',
              p99: productStats.stats.percentiles['0.99'] + 'ms',
              max: productStats.stats.percentiles['1'] + 'ms',
            }
          : null,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Manual circuit breaker control (for testing/maintenance)
 * POST /api/health/circuit/open
 */
router.post('/health/circuit/open', (req, res) => {
  productClient.openCircuit();
  res.json({
    message: 'Circuit breaker manually opened',
    state: 'OPEN',
  });
});

/**
 * Manual circuit breaker control (for testing/maintenance)
 * POST /api/health/circuit/close
 */
router.post('/health/circuit/close', (req, res) => {
  productClient.closeCircuit();
  res.json({
    message: 'Circuit breaker manually closed',
    state: 'CLOSED',
  });
});

module.exports = router;
