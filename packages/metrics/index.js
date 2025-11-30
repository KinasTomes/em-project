/**
 * @ecommerce/metrics
 * 
 * Shared Prometheus metrics package for ecommerce microservices.
 * Provides standardized metrics collection, HTTP middleware, and endpoint handler.
 * 
 * Features:
 * - Default process metrics (CPU, Memory, Event Loop)
 * - HTTP request duration histogram
 * - HTTP request counter
 * - Active connections gauge
 * - Route normalization to prevent high cardinality
 * 
 * @example
 * const { metricsMiddleware, metricsHandler } = require('@ecommerce/metrics');
 * 
 * app.use(metricsMiddleware('order-service'));
 * app.get('/metrics', metricsHandler);
 */

const promClient = require('prom-client');

// ============================================
// REGISTRY & DEFAULT METRICS
// ============================================

// Create a custom registry for better control
const register = new promClient.Registry();

// Add default labels to all metrics
register.setDefaultLabels({
  app: 'ecommerce'
});

// Collect default metrics (CPU, Memory, Event Loop lag, etc.)
promClient.collectDefaultMetrics({
  register,
  prefix: 'ecommerce_',
  // Collect every 10 seconds
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]
});

// ============================================
// HTTP METRICS
// ============================================

/**
 * HTTP Request Duration Histogram
 * Measures the duration of HTTP requests in seconds
 */
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code', 'service'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

/**
 * HTTP Request Counter
 * Counts total number of HTTP requests
 */
const httpRequestTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'service'],
  registers: [register]
});

/**
 * Active HTTP Connections Gauge
 * Tracks number of currently active HTTP connections
 */
const activeConnections = new promClient.Gauge({
  name: 'http_active_connections',
  help: 'Number of active HTTP connections',
  labelNames: ['service'],
  registers: [register]
});

// ============================================
// ROUTE NORMALIZATION
// ============================================

/**
 * Normalize route path to prevent high cardinality issues.
 * Converts dynamic segments like /orders/123 to /orders/:id
 * 
 * Priority:
 * 1. Use Express route pattern (req.route?.path) - Best option
 * 2. Use base path (req.baseUrl + pattern) for routers
 * 3. Fallback to manual normalization
 * 
 * @param {Object} req - Express request object
 * @returns {string} Normalized route path
 */
function normalizeRoute(req) {
  // Best case: Express provides the route pattern
  if (req.route?.path) {
    // Combine baseUrl (from router) with route path
    const basePath = req.baseUrl || '';
    const routePath = req.route.path;
    return `${basePath}${routePath}`;
  }

  // Fallback: Manual normalization for paths without route patterns
  const path = req.originalUrl?.split('?')[0] || req.path || '/';
  
  // Common patterns to normalize (prevent high cardinality)
  return path
    // MongoDB ObjectIds (24 hex chars)
    .replace(/[a-f0-9]{24}/gi, ':id')
    // UUIDs
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, ':uuid')
    // Numeric IDs
    .replace(/\/\d+/g, '/:id')
    // Remove trailing slashes (except root)
    .replace(/\/+$/, '') || '/';
}

// ============================================
// MIDDLEWARE
// ============================================

/**
 * Express middleware for collecting HTTP metrics
 * 
 * @param {string} serviceName - Name of the service (e.g., 'order-service')
 * @returns {Function} Express middleware function
 * 
 * @example
 * app.use(metricsMiddleware('order-service'));
 */
function metricsMiddleware(serviceName) {
  return (req, res, next) => {
    // Skip metrics endpoint itself to avoid recursion
    if (req.path === '/metrics') {
      return next();
    }

    // Increment active connections
    activeConnections.inc({ service: serviceName });

    // Start timing
    const startTime = process.hrtime.bigint();

    // Capture response finish
    res.on('finish', () => {
      // Calculate duration in seconds
      const endTime = process.hrtime.bigint();
      const durationInSeconds = Number(endTime - startTime) / 1e9;

      // Get normalized route
      const route = normalizeRoute(req);

      // Build labels
      const labels = {
        method: req.method,
        route,
        status_code: res.statusCode,
        service: serviceName
      };

      // Record metrics
      httpRequestDuration.observe(labels, durationInSeconds);
      httpRequestTotal.inc(labels);

      // Decrement active connections
      activeConnections.dec({ service: serviceName });
    });

    // Handle connection close (client disconnect)
    res.on('close', () => {
      if (!res.writableEnded) {
        activeConnections.dec({ service: serviceName });
      }
    });

    next();
  };
}

// ============================================
// ENDPOINT HANDLER
// ============================================

/**
 * Express handler for /metrics endpoint
 * Returns metrics in Prometheus text format
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * 
 * @example
 * app.get('/metrics', metricsHandler);
 */
async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.end(metrics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to collect metrics',
      message: error.message
    });
  }
}

// ============================================
// CUSTOM METRIC FACTORIES
// ============================================

/**
 * Create a custom Counter metric
 * 
 * @param {Object} options - Counter options
 * @param {string} options.name - Metric name
 * @param {string} options.help - Metric description
 * @param {string[]} [options.labelNames] - Label names
 * @returns {promClient.Counter}
 * 
 * @example
 * const ordersCreated = createCounter({
 *   name: 'orders_created_total',
 *   help: 'Total orders created',
 *   labelNames: ['status']
 * });
 * ordersCreated.inc({ status: 'pending' });
 */
function createCounter(options) {
  return new promClient.Counter({
    ...options,
    registers: [register]
  });
}

/**
 * Create a custom Gauge metric
 * 
 * @param {Object} options - Gauge options
 * @param {string} options.name - Metric name
 * @param {string} options.help - Metric description
 * @param {string[]} [options.labelNames] - Label names
 * @returns {promClient.Gauge}
 * 
 * @example
 * const queueSize = createGauge({
 *   name: 'queue_size',
 *   help: 'Current queue size',
 *   labelNames: ['queue_name']
 * });
 * queueSize.set({ queue_name: 'orders' }, 42);
 */
function createGauge(options) {
  return new promClient.Gauge({
    ...options,
    registers: [register]
  });
}

/**
 * Create a custom Histogram metric
 * 
 * @param {Object} options - Histogram options
 * @param {string} options.name - Metric name
 * @param {string} options.help - Metric description
 * @param {string[]} [options.labelNames] - Label names
 * @param {number[]} [options.buckets] - Histogram buckets
 * @returns {promClient.Histogram}
 * 
 * @example
 * const processingDuration = createHistogram({
 *   name: 'order_processing_duration_seconds',
 *   help: 'Order processing duration',
 *   labelNames: ['status'],
 *   buckets: [0.1, 0.5, 1, 2, 5]
 * });
 * const end = processingDuration.startTimer();
 * // ... do work ...
 * end({ status: 'completed' });
 */
function createHistogram(options) {
  return new promClient.Histogram({
    ...options,
    registers: [register]
  });
}

/**
 * Create a custom Summary metric
 * 
 * @param {Object} options - Summary options
 * @param {string} options.name - Metric name
 * @param {string} options.help - Metric description
 * @param {string[]} [options.labelNames] - Label names
 * @param {Object} [options.percentiles] - Percentiles to calculate
 * @returns {promClient.Summary}
 */
function createSummary(options) {
  return new promClient.Summary({
    ...options,
    registers: [register]
  });
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Prometheus client (for advanced usage)
  promClient,
  
  // Registry
  register,
  
  // Pre-configured HTTP metrics
  httpRequestDuration,
  httpRequestTotal,
  activeConnections,
  
  // Middleware & Handler
  metricsMiddleware,
  metricsHandler,
  
  // Utility
  normalizeRoute,
  
  // Custom metric factories
  createCounter,
  createGauge,
  createHistogram,
  createSummary
};
