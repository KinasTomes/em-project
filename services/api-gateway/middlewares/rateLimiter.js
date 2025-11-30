/**
 * Rate Limiter Middleware
 * 
 * Implements IP-based rate limiting with different limits for:
 * - General API requests
 * - Authentication endpoints (stricter limits to prevent brute force)
 * 
 * Can be disabled via DISABLE_RATE_LIMIT=true environment variable for load testing.
 */

const logger = require('@ecommerce/logger');

// Lazy load metrics to avoid circular dependencies
let gatewayMetrics = null;
function getMetrics() {
  if (!gatewayMetrics) {
    gatewayMetrics = require('../metrics');
  }
  return gatewayMetrics;
}

// Check if rate limiting is disabled (for load testing)
const isRateLimitDisabled = process.env.DISABLE_RATE_LIMIT === 'true';

// In-memory store for rate limiting (use Redis in production for distributed systems)
const requestCounts = new Map();

// Cleanup old entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of requestCounts.entries()) {
    if (now - data.windowStart > data.windowMs) {
      requestCounts.delete(key);
    }
  }
}, 60000);

/**
 * Create rate limiter middleware
 * @param {Object} options - Configuration options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 * @param {number} options.maxRequests - Maximum requests per window (default: 100)
 * @param {string} options.message - Error message when limit exceeded
 * @param {boolean} options.skipFailedRequests - Don't count failed requests (default: false)
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000, // 1 minute
    maxRequests = 100,
    message = 'Too many requests, please try again later.',
    keyGenerator = (req) => getClientIp(req),
  } = options;

  return (req, res, next) => {
    // Skip rate limiting if disabled (for load testing)
    if (isRateLimitDisabled) {
      return next();
    }

    const key = keyGenerator(req);
    const now = Date.now();

    let record = requestCounts.get(key);

    if (!record || now - record.windowStart > windowMs) {
      // Start new window
      record = {
        count: 1,
        windowStart: now,
        windowMs,
      };
      requestCounts.set(key, record);
    } else {
      record.count++;
    }

    // Calculate remaining requests and reset time
    const remaining = Math.max(0, maxRequests - record.count);
    const resetTime = Math.ceil((record.windowStart + windowMs - now) / 1000);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetTime);

    if (record.count > maxRequests) {
      logger.warn(
        { ip: key, count: record.count, limit: maxRequests, path: req.path },
        'Rate limit exceeded'
      );

      // Record rate limit hit metric
      try {
        getMetrics().recordRateLimitHit(options.limiterName || 'general', req.path);
      } catch (e) {
        // Ignore metrics errors
      }

      res.setHeader('Retry-After', resetTime);
      return res.status(429).json({
        error: 'Too Many Requests',
        message,
        retryAfter: resetTime,
      });
    }

    next();
  };
}

/**
 * Get client IP address (handles proxies)
 */
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// Pre-configured rate limiters

/**
 * General API rate limiter
 * 100 requests per minute per IP
 */
const generalLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,
  message: 'Too many requests from this IP, please try again after a minute.',
  limiterName: 'general',
});

/**
 * Auth endpoints rate limiter (stricter)
 * 10 requests per minute per IP for login/register
 * Prevents brute force attacks
 */
const authLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10,
  message: 'Too many authentication attempts, please try again after a minute.',
  limiterName: 'auth',
});

/**
 * Strict rate limiter for password reset
 * 3 requests per 15 minutes per IP
 */
const passwordResetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 3,
  message: 'Too many password reset attempts, please try again later.',
  limiterName: 'password_reset',
});

/**
 * API write operations limiter
 * 30 requests per minute per IP for POST/PUT/DELETE
 */
const writeLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,
  message: 'Too many write operations, please try again after a minute.',
  limiterName: 'write',
});

module.exports = {
  createRateLimiter,
  generalLimiter,
  authLimiter,
  passwordResetLimiter,
  writeLimiter,
  getClientIp,
};
