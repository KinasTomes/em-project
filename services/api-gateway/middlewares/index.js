/**
 * API Gateway Middlewares
 * 
 * Centralized exports for all middleware modules
 */

const { 
  createRateLimiter,
  generalLimiter,
  authLimiter,
  passwordResetLimiter,
  writeLimiter,
  getClientIp,
} = require('./rateLimiter');

const {
  authenticate,
  authorize,
  extractToken,
  parseJwt,
  isPublicPath,
  conditionalAuth,
  publicPaths,
} = require('./auth');

const {
  corsMiddleware,
  strictCors,
  devCors,
  permissiveCors,
  isOriginAllowed,
} = require('./cors');

const {
  createValidator,
  bodyParser,
  validateBody,
  generateRequestId,
  schemas,
} = require('./requestValidator');

const {
  circuitBreakerMiddleware,
  getCircuitBreaker,
  getCircuitState,
  getAllCircuitStats,
  recordSuccess,
  recordFailure,
  isCircuitOpen,
} = require('./circuitBreaker');

module.exports = {
  // Rate Limiting
  createRateLimiter,
  generalLimiter,
  authLimiter,
  passwordResetLimiter,
  writeLimiter,
  getClientIp,

  // Authentication
  authenticate,
  authorize,
  extractToken,
  parseJwt,
  isPublicPath,
  conditionalAuth,
  publicPaths,

  // CORS
  corsMiddleware,
  strictCors,
  devCors,
  permissiveCors,
  isOriginAllowed,

  // Request Validation
  createValidator,
  bodyParser,
  validateBody,
  generateRequestId,
  schemas,

  // Circuit Breaker
  circuitBreakerMiddleware,
  getCircuitBreaker,
  getCircuitState,
  getAllCircuitStats,
  recordSuccess,
  recordFailure,
  isCircuitOpen,
};
