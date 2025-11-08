const dotenv = require('dotenv');
const path = require('path');

/**
 * Load environment variables from .env file
 * This will be called from each service directory
 */
function loadConfig() {
  // Load .env from current working directory (service directory)
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
  
  return {
    // Common environment variables
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: parseInt(process.env.PORT) || 3000,
    
    // MongoDB
    MONGO_URL: process.env.MONGO_URL || process.env.MONGODB_URI,
    MONGODB_AUTH_URI: process.env.MONGODB_AUTH_URI,
    MONGODB_ORDER_URI: process.env.MONGODB_ORDER_URI,
    MONGODB_PRODUCT_URI: process.env.MONGODB_PRODUCT_URI,
    
    // JWT
    JWT_SECRET: process.env.JWT_SECRET || 'secret',
    
    // RabbitMQ
    RABBITMQ_URL: process.env.RABBITMQ_URL || process.env.RABBITMQ_URI || 'amqp://localhost',
    
    // Service-specific helpers
    getMongoURI: (serviceName) => {
      const uriMap = {
        auth: process.env.MONGODB_AUTH_URI,
        order: process.env.MONGODB_ORDER_URI,
        product: process.env.MONGODB_PRODUCT_URI,
      };
      return uriMap[serviceName] || process.env.MONGO_URL || `mongodb://localhost/${serviceName}`;
    },
    
    getPort: (defaultPort) => {
      return parseInt(process.env.PORT) || defaultPort;
    },
  };
}

module.exports = loadConfig();