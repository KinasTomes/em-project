/**
 * Request Validation Middleware
 * 
 * Validates incoming requests at the API Gateway level:
 * - Content-Type validation
 * - URL length validation
 * - Request ID generation
 */

const logger = require('@ecommerce/logger');

/**
 * Default validation options
 */
const defaultOptions = {
  maxBodySize: 1024 * 1024, // 1MB
  maxUrlLength: 2048,
  allowedContentTypes: [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ],
  // Removed sanitizeBody option; input validation only
};

// Removed sanitizeString and sanitizeObject functions; input validation only
/**
 * Validate Content-Type header
 */
function validateContentType(req, allowedTypes) {
  // Skip for requests without body
  if (['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method)) {
    return true;
  }

  const contentType = req.headers['content-type'];
  
  if (!contentType) {
    return false;
  }

  // Check if content type starts with any allowed type
  return allowedTypes.some(allowed => 
    contentType.toLowerCase().startsWith(allowed)
  );
}

/**
 * Create request validator middleware
 */
function createValidator(options = {}) {
  const config = { ...defaultOptions, ...options };

  return (req, res, next) => {
    // Validate URL length
    if (req.url.length > config.maxUrlLength) {
      logger.warn(
        { urlLength: req.url.length, maxLength: config.maxUrlLength },
        '✗ URL too long'
      );
      return res.status(414).json({
        error: 'URI Too Long',
        message: `URL exceeds maximum length of ${config.maxUrlLength} characters`,
      });
    }

    // Validate Content-Type for requests with body
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (!validateContentType(req, config.allowedContentTypes)) {
        const contentType = req.headers['content-type'] || 'none';
        logger.warn(
          { contentType, allowed: config.allowedContentTypes },
          '✗ Invalid Content-Type'
        );
        return res.status(415).json({
          error: 'Unsupported Media Type',
          message: 'Content-Type must be application/json',
          received: contentType,
        });
      }
    }

    // Add request ID if not present
    if (!req.headers['x-request-id']) {
      req.headers['x-request-id'] = generateRequestId();
    }

    // Set response header for tracking
    res.setHeader('X-Request-ID', req.headers['x-request-id']);

    next();
  };
}

/**
 * Generate unique request ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Body parser with size limit
 */
function bodyParser(options = {}) {
  const maxSize = options.maxSize || defaultOptions.maxBodySize;

  return (req, res, next) => {
    // Skip for requests without body
    if (['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const contentType = req.headers['content-type'] || '';
    
    // Only parse JSON
    if (!contentType.includes('application/json')) {
      return next();
    }

    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      
      if (size > maxSize) {
        logger.warn({ size, maxSize }, '✗ Request body too large');
        res.status(413).json({
          error: 'Payload Too Large',
          message: `Request body exceeds maximum size of ${maxSize} bytes`,
        });
        req.destroy();
        return;
      }
      
      body += chunk.toString();
    });

    req.on('end', () => {
      if (body) {
        try {
          req.body = JSON.parse(body);
        } catch (error) {
          logger.warn({ error: error.message }, '✗ Invalid JSON body');
          return res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid JSON in request body',
          });
        }
      }
      next();
    });

    req.on('error', (error) => {
      logger.error({ error: error.message }, '✗ Request error');
      if (!res.headersSent) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Error reading request body',
        });
      }
    });
  };
}

/**
 * Validate required fields in request body
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body?.[field];

      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }

      if (value !== undefined && value !== null) {
        if (rules.type && typeof value !== rules.type) {
          errors.push(`${field} must be of type ${rules.type}`);
        }

        if (rules.minLength && typeof value === 'string' && value.length < rules.minLength) {
          errors.push(`${field} must be at least ${rules.minLength} characters`);
        }

        if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
          errors.push(`${field} must be at most ${rules.maxLength} characters`);
        }

        if (rules.pattern && typeof value === 'string' && !rules.pattern.test(value)) {
          errors.push(`${field} has invalid format`);
        }

        if (rules.enum && !rules.enum.includes(value)) {
          errors.push(`${field} must be one of: ${rules.enum.join(', ')}`);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Request validation failed',
        details: errors,
      });
    }

    next();
  };
}

// Common validation schemas
const schemas = {
  login: {
    email: { required: true, type: 'string', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    password: { required: true, type: 'string', minLength: 6 },
  },
  register: {
    email: { required: true, type: 'string', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    password: { required: true, type: 'string', minLength: 8 },
    name: { required: true, type: 'string', minLength: 2, maxLength: 100 },
  },
};

module.exports = {
  createValidator,
  bodyParser,
  validateBody,
  generateRequestId,
  schemas,
  defaultOptions,
};
