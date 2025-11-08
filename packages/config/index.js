const dotenv = require('dotenv');
const path = require('path');
const { z } = require('zod');

/**
 * Define the schema for environment variables with strict validation
 */
const envSchema = z.object({
  // Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Port with range validation
  PORT: z.coerce.number().min(1024, 'PORT must be >= 1024').max(65535, 'PORT must be <= 65535').optional().default(3000),
  
  // MongoDB - validate URL format when provided
  MONGO_URL: z.string().url('MONGO_URL must be a valid URL').optional().or(z.literal('')),
  MONGODB_URI: z.string().url('MONGODB_URI must be a valid URL').optional().or(z.literal('')),
  MONGODB_AUTH_URI: z.string().url('MONGODB_AUTH_URI must be a valid URL').optional().or(z.literal('')),
  MONGODB_ORDER_URI: z.string().url('MONGODB_ORDER_URI must be a valid URL').optional().or(z.literal('')),
  MONGODB_PRODUCT_URI: z.string().url('MONGODB_PRODUCT_URI must be a valid URL').optional().or(z.literal('')),
  
  // JWT - Must be at least 32 characters for security
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters for security').default('development-secret-change-in-production-min-32-chars'),
  
  // RabbitMQ - validate AMQP URL format when provided
  RABBITMQ_URL: z.string().regex(/^amqps?:\/\//, 'RABBITMQ_URL must start with amqp:// or amqps://').optional().or(z.literal('')),
  RABBITMQ_URI: z.string().regex(/^amqps?:\/\//, 'RABBITMQ_URI must start with amqp:// or amqps://').optional().or(z.literal('')),
}).refine((data) => {
  // Production-specific validations
  if (data.NODE_ENV === 'production') {
    if (data.JWT_SECRET.includes('development') || data.JWT_SECRET.includes('change-in-production')) {
      return false;
    }
  }
  return true;
}, {
  message: '🚨 JWT_SECRET must be changed from default value in production environment!',
  path: ['JWT_SECRET']
});

/**
 * Load and validate environment variables from .env file
 * This will be called from each service directory
 * 
 * Strategy:
 * 1. Try to load .env from the service's own directory (e.g., services/auth/.env)
 * 2. If not found, try to load from workspace root (.env)
 * 3. This allows both individual service testing AND shared configuration
 */
function loadConfig() {
  const path = require('path');
  const fs = require('fs');
  
  // Strategy 1: Try service-specific .env first
  // When running from service dir: services/auth/.env
  const localEnvPath = path.resolve(process.cwd(), '.env');
  
  // Strategy 2: Try workspace root .env as fallback
  // Find workspace root by looking for pnpm-workspace.yaml
  let workspaceRoot = process.cwd();
  let currentDir = process.cwd();
  
  // Walk up the directory tree to find workspace root
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      workspaceRoot = currentDir;
      break;
    }
    currentDir = path.dirname(currentDir);
  }
  
  const rootEnvPath = path.join(workspaceRoot, '.env');
  
  // Load service-specific first, then root as fallback
  if (fs.existsSync(localEnvPath)) {
    console.log(`📁 Loading config from: ${localEnvPath}`);
    dotenv.config({ path: localEnvPath });
  } else if (fs.existsSync(rootEnvPath)) {
    console.log(`📁 Loading config from workspace root: ${rootEnvPath}`);
    dotenv.config({ path: rootEnvPath });
  } else {
    console.warn('⚠️  No .env file found. Using environment variables only.');
  }

  try {
    const validatedEnv = envSchema.parse(process.env);
    
    return {
      ...validatedEnv,
      
      // Service-specific helpers
      getMongoURI: (serviceName) => {
        const uriMap = {
          auth: validatedEnv.MONGODB_AUTH_URI,
          order: validatedEnv.MONGODB_ORDER_URI,
          product: validatedEnv.MONGODB_PRODUCT_URI,
        };
        return uriMap[serviceName] || validatedEnv.MONGO_URL || validatedEnv.MONGODB_URI || `mongodb://localhost/${serviceName}`;
      },
      
      getPort: (defaultPort) => {
        return validatedEnv.PORT || defaultPort;
      },

      // A helper to get the RabbitMQ URL, considering both variables.
      getRabbitMQUrl: () => {
        return validatedEnv.RABBITMQ_URL || validatedEnv.RABBITMQ_URI || 'amqp://localhost';
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('\n❌ Environment variable validation failed:\n');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      error.issues.forEach((issue) => {
        const field = issue.path.join('.') || 'root';
        const message = issue.message;
        console.error(`  ⚠️  ${field}: ${message}`);
      });
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      console.error('💡 Tip: Check your .env file and ensure all required variables are set correctly.\n');
    } else {
      console.error('\n❌ Configuration loading error:', error.message);
    }
    process.exit(1);
  }
}

module.exports = loadConfig();

// Export schema for testing or TypeScript type inference
module.exports.envSchema = envSchema;

// Export helper for manual validation (useful for testing)
module.exports.validateEnv = (env) => {
  return envSchema.parse(env);
};