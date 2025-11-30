/**
 * API Gateway Specific Metrics
 * 
 * Custom business metrics for monitoring the API Gateway:
 * - Proxy request duration to downstream services
 * - Rate limit hits
 * - Authentication failures
 * - Upstream service health
 */

const { createCounter, createHistogram, createGauge } = require('@ecommerce/metrics');

// ============================================
// PROXY METRICS
// ============================================

/**
 * Proxy Request Duration Histogram
 * Measures latency to downstream services
 */
const proxyRequestDuration = createHistogram({
  name: 'gateway_proxy_request_duration_seconds',
  help: 'Duration of proxied requests to downstream services',
  labelNames: ['target_service', 'method', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
});

/**
 * Proxy Requests Total Counter
 */
const proxyRequestsTotal = createCounter({
  name: 'gateway_proxy_requests_total',
  help: 'Total number of proxied requests',
  labelNames: ['target_service', 'method', 'status_code']
});

/**
 * Proxy Errors Counter
 */
const proxyErrors = createCounter({
  name: 'gateway_proxy_errors_total',
  help: 'Total number of proxy errors',
  labelNames: ['target_service', 'error_code']
});

// ============================================
// RATE LIMIT METRICS
// ============================================

/**
 * Rate Limit Hits Counter
 * Tracks how often rate limits are triggered
 */
const rateLimitHits = createCounter({
  name: 'gateway_rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['limiter_type', 'path']
});

// ============================================
// AUTHENTICATION METRICS
// ============================================

/**
 * Auth Failures Counter
 * Tracks authentication failures by reason
 */
const authFailures = createCounter({
  name: 'gateway_auth_failures_total',
  help: 'Total authentication failures',
  labelNames: ['reason'] // token_missing, token_expired, token_invalid, forbidden
});

/**
 * Auth Success Counter
 */
const authSuccess = createCounter({
  name: 'gateway_auth_success_total',
  help: 'Total successful authentications'
});

// ============================================
// UPSTREAM HEALTH METRICS
// ============================================

/**
 * Upstream Service Health Gauge
 * 0 = unhealthy, 1 = healthy
 */
const upstreamHealth = createGauge({
  name: 'gateway_upstream_health',
  help: 'Upstream service health status (0=unhealthy, 1=healthy)',
  labelNames: ['service']
});

// Initialize all services as healthy
const services = ['auth', 'product', 'order', 'inventory', 'payment'];
services.forEach(service => {
  upstreamHealth.set({ service }, 1);
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Extract service name from URL
 */
function getServiceFromUrl(url) {
  if (url.includes('auth')) return 'auth';
  if (url.includes('product')) return 'product';
  if (url.includes('order')) return 'order';
  if (url.includes('inventory')) return 'inventory';
  if (url.includes('payment')) return 'payment';
  return 'unknown';
}

/**
 * Record proxy request metrics
 */
function recordProxyRequest(targetService, method, statusCode, durationSeconds) {
  const labels = { target_service: targetService, method, status_code: statusCode };
  proxyRequestDuration.observe(labels, durationSeconds);
  proxyRequestsTotal.inc(labels);
}

/**
 * Record proxy error
 */
function recordProxyError(targetService, errorCode) {
  proxyErrors.inc({ target_service: targetService, error_code: errorCode || 'UNKNOWN' });
  // Mark service as unhealthy
  upstreamHealth.set({ service: targetService }, 0);
}

/**
 * Record rate limit hit
 */
function recordRateLimitHit(limiterType, path) {
  rateLimitHits.inc({ limiter_type: limiterType, path: normalizePath(path) });
}

/**
 * Record auth failure
 */
function recordAuthFailure(reason) {
  authFailures.inc({ reason });
}

/**
 * Record auth success
 */
function recordAuthSuccess() {
  authSuccess.inc();
}

/**
 * Set upstream service health
 */
function setUpstreamHealth(service, isHealthy) {
  upstreamHealth.set({ service }, isHealthy ? 1 : 0);
}

/**
 * Normalize path to prevent high cardinality
 */
function normalizePath(path) {
  return path
    .replace(/[a-f0-9]{24}/gi, ':id')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, ':uuid')
    .replace(/\/\d+/g, '/:id')
    .split('?')[0] || '/';
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Metrics
  proxyRequestDuration,
  proxyRequestsTotal,
  proxyErrors,
  rateLimitHits,
  authFailures,
  authSuccess,
  upstreamHealth,
  
  // Helper functions
  getServiceFromUrl,
  recordProxyRequest,
  recordProxyError,
  recordRateLimitHit,
  recordAuthFailure,
  recordAuthSuccess,
  setUpstreamHealth,
  normalizePath,
};
