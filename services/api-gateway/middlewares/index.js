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
  sanitizeString,
  sanitizeObject,
  generateRequestId,
  schemas,
} = require('./requestValidator');

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
  sanitizeString,
  sanitizeObject,
  generateRequestId,
  schemas,
};
