/**
 * CORS (Cross-Origin Resource Sharing) Middleware
 * 
 * Configures CORS headers to control cross-origin requests.
 */

const config = require('../config');
const logger = require('@ecommerce/logger');

/**
 * Default CORS options
 */
const defaultOptions = {
  // Allowed origins (use array or function for dynamic checking)
  origins: config.corsOrigins || ['http://localhost:3000', 'http://localhost:5173'],
  
  // Allowed HTTP methods
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  
  // Allowed headers
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Request-ID',
    'X-Correlation-ID',
  ],
  
  // Headers exposed to the client
  exposedHeaders: [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-Request-ID',
    'X-Response-Time',
  ],
  
  // Allow credentials (cookies, authorization headers)
  credentials: true,
  
  // Preflight cache duration (24 hours)
  maxAge: 86400,
  
  // Allow preflight for all routes
  preflightContinue: false,
  
  // Success status for OPTIONS requests
  optionsSuccessStatus: 204,
};

/**
 * Check if origin is allowed
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true; // Same-origin request
  
  if (allowedOrigins === '*') return true;
  
  if (Array.isArray(allowedOrigins)) {
    return allowedOrigins.some(allowed => {
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return allowed === origin;
    });
  }
  
  if (typeof allowedOrigins === 'function') {
    return allowedOrigins(origin);
  }
  
  return allowedOrigins === origin;
}

/**
 * Create CORS middleware
 */
function corsMiddleware(options = {}) {
  const config = { ...defaultOptions, ...options };

  return (req, res, next) => {
    const origin = req.headers.origin;
    
    // Check if origin is allowed
    if (origin && isOriginAllowed(origin, config.origins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (config.origins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // Allow credentials
    if (config.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // Expose headers to client
    if (config.exposedHeaders.length > 0) {
      res.setHeader('Access-Control-Expose-Headers', config.exposedHeaders.join(', '));
    }

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      // Allowed methods
      res.setHeader('Access-Control-Allow-Methods', config.methods.join(', '));
      
      // Allowed headers
      res.setHeader('Access-Control-Allow-Headers', config.allowedHeaders.join(', '));
      
      // Cache preflight response
      res.setHeader('Access-Control-Max-Age', config.maxAge);

      logger.debug(
        { origin, path: req.path },
        'CORS preflight request'
      );

      // End preflight request
      if (!config.preflightContinue) {
        return res.status(config.optionsSuccessStatus).end();
      }
    }

    next();
  };
}

/**
 * Strict CORS for production
 * Only allows specific origins
 */
const strictCors = corsMiddleware({
  origins: config.corsOrigins || [],
  credentials: true,
});

/**
 * Development CORS
 * Allows localhost origins
 */
const devCors = corsMiddleware({
  origins: [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    /^http:\/\/localhost:\d+$/,
  ],
  credentials: true,
});

/**
 * Permissive CORS (for testing only!)
 */
const permissiveCors = corsMiddleware({
  origins: '*',
  credentials: false, // Can't use credentials with wildcard origin
});

module.exports = {
  corsMiddleware,
  strictCors,
  devCors,
  permissiveCors,
  isOriginAllowed,
  defaultOptions,
};
