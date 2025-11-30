/**
 * Centralized Authentication Middleware
 * 
 * Verifies JWT tokens at the API Gateway level before proxying requests.
 * This provides a single point of authentication for all microservices.
 */

const logger = require('@ecommerce/logger');
const config = require('../config');

// Lazy load metrics to avoid circular dependencies
let gatewayMetrics = null;
function getMetrics() {
  if (!gatewayMetrics) {
    gatewayMetrics = require('../metrics');
  }
  return gatewayMetrics;
}

// JWT verification without external dependencies (using Node.js crypto)
const crypto = require('crypto');

/**
 * Decode base64url to string
 */
function base64UrlDecode(str) {
  // Add padding if needed
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Verify JWT signature (HS256)
 */
function verifyJwtSignature(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const [header, payload, signature] = parts;
  const data = `${header}.${payload}`;
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (signature !== expectedSignature) {
    throw new Error('Invalid signature');
  }

  return JSON.parse(base64UrlDecode(payload));
}

/**
 * Parse and validate JWT token
 */
function parseJwt(token, secret) {
  try {
    const payload = verifyJwtSignature(token, secret);
    
    // Check expiration
    if (payload.exp && Date.now() >= payload.exp * 1000) {
      throw new Error('Token expired');
    }

    // Check not before
    if (payload.nbf && Date.now() < payload.nbf * 1000) {
      throw new Error('Token not yet valid');
    }

    return payload;
  } catch (error) {
    throw error;
  }
}

/**
 * Extract token from Authorization header
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return null;
  }

  // Support both "Bearer <token>" and just "<token>"
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return authHeader;
}

/**
 * Authentication middleware
 * Verifies JWT and attaches user info to request headers for downstream services
 */
function authenticate(options = {}) {
  const { 
    optional = false, // If true, continues even without valid token
  } = options;

  return (req, res, next) => {
    const token = extractToken(req);

    if (!token) {
      if (optional) {
        return next();
      }
      // Record auth failure metric
      try {
        getMetrics().recordAuthFailure('token_missing');
      } catch (e) {
        // Ignore metrics errors
      }
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication token required',
      });
    }

    try {
      const payload = parseJwt(token, config.jwtSecret);
      
      // Attach user info to headers for downstream services
      req.headers['x-user-id'] = payload.userId || payload.sub || payload.id;
      req.headers['x-user-email'] = payload.email || '';
      req.headers['x-user-role'] = payload.role || 'user';
      req.headers['x-auth-verified'] = 'true';

      logger.debug(
        { userId: req.headers['x-user-id'], path: req.path },
        '✓ Token verified'
      );

      // Record auth success metric
      try {
        getMetrics().recordAuthSuccess();
      } catch (e) {
        // Ignore metrics errors
      }

      next();
    } catch (error) {
      logger.warn(
        { error: error.message, path: req.path },
        '✗ Token verification failed'
      );

      if (optional) {
        return next();
      }

      // Record auth failure metric
      try {
        const reason = error.message === 'Token expired' ? 'token_expired' : 'token_invalid';
        getMetrics().recordAuthFailure(reason);
      } catch (e) {
        // Ignore metrics errors
      }

      if (error.message === 'Token expired') {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Token has expired',
          code: 'TOKEN_EXPIRED',
        });
      }

      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid authentication token',
      });
    }
  };
}

/**
 * Role-based authorization middleware
 * Must be used after authenticate middleware
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    const userRole = req.headers['x-user-role'];
    
    if (!userRole) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    if (!allowedRoles.includes(userRole)) {
      logger.warn(
        { userRole, allowedRoles, path: req.path },
        '✗ Authorization failed - insufficient permissions'
      );

      // Record auth failure metric
      try {
        getMetrics().recordAuthFailure('forbidden');
      } catch (e) {
        // Ignore metrics errors
      }

      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions',
      });
    }

    next();
  };
}

/**
 * Paths that don't require authentication
 */
const publicPaths = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/forgot-password',
  '/health',
  '/products', // Public product listing
];

/**
 * Check if path is public (no auth required)
 */
function isPublicPath(path) {
  // Exact match or starts with public path
  return publicPaths.some(publicPath => 
    path === publicPath || 
    path.startsWith(`${publicPath}/`) ||
    path.startsWith(`${publicPath}?`)
  );
}

/**
 * Conditional authentication middleware
 * Applies authentication based on path
 */
function conditionalAuth(req, res, next) {
  // Skip auth for public paths
  if (isPublicPath(req.path)) {
    return next();
  }

  // GET requests to products are public
  if (req.method === 'GET' && req.path.startsWith('/products')) {
    return next();
  }

  // Apply authentication for other paths
  return authenticate()(req, res, next);
}

module.exports = {
  authenticate,
  authorize,
  extractToken,
  parseJwt,
  isPublicPath,
  conditionalAuth,
  publicPaths,
};
