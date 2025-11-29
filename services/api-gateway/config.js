const sharedConfig = require("@ecommerce/config");

module.exports = {
  // Server
  port: sharedConfig.getPort(3003),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Service URLs
  authServiceUrl: process.env.AUTH_SERVICE_URL || "http://localhost:3001",
  productServiceUrl: process.env.PRODUCT_SERVICE_URL || "http://localhost:3004",
  orderServiceUrl: process.env.ORDER_SERVICE_URL || "http://localhost:3002",
  inventoryServiceUrl: process.env.INVENTORY_SERVICE_URL || "http://localhost:3005",
  paymentServiceUrl: process.env.PAYMENT_SERVICE_URL || "http://localhost:3006",
  
  // JWT Configuration
  jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
  
  // CORS Configuration
  corsOrigins: process.env.CORS_ORIGINS 
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'],
  
  // Rate Limiting
  rateLimiting: {
    general: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000, // 1 minute
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    },
    auth: {
      windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 60 * 1000, // 1 minute
      maxRequests: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS) || 10,
    },
  },
  
  // Proxy Configuration
  proxy: {
    timeout: parseInt(process.env.PROXY_TIMEOUT) || 10000,
    proxyTimeout: parseInt(process.env.PROXY_TIMEOUT) || 10000,
  },
};
