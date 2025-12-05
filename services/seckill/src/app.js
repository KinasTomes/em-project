const express = require('express')
const logger = require('@ecommerce/logger')
const { metricsMiddleware, metricsHandler } = require('@ecommerce/metrics')
const config = require('./config')
const redisClient = require('./config/redis')
const seckillService = require('./services/seckillService')
const seckillRoutes = require('./routes/seckillRoutes')
const adminRoutes = require('./routes/adminRoutes')
const { registerReleaseConsumer } = require('./consumers/releaseConsumer')

// Import ES modules dynamically
let Broker

/**
 * Seckill Service Express Application
 * 
 * High-performance flash sale microservice with:
 * - Redis for atomic stock management
 * - Lua scripts for transactional operations
 * - RabbitMQ for event publishing and consumption
 * 
 * Requirements: 8.1
 */
class App {
  constructor() {
    this.app = express()
    this.server = null
    this.broker = null
  }

  /**
   * Set up Express middlewares
   */
  setMiddlewares() {
    // Metrics middleware (must be early in chain)
    this.app.use(metricsMiddleware('seckill-service'))
    
    // JSON body parsing
    this.app.use(express.json())
    this.app.use(express.urlencoded({ extended: false }))

    // Request logging middleware
    this.app.use((req, res, next) => {
      logger.debug({ method: req.method, path: req.path }, 'Incoming request')
      next()
    })
  }

  /**
   * Set up routes and error handlers
   */
  setRoutes() {
    // Metrics endpoint
    this.app.get('/metrics', metricsHandler)

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      const redisReady = redisClient.isReady()
      res.status(redisReady ? 200 : 503).json({
        status: redisReady ? 'healthy' : 'unhealthy',
        service: config.serviceName,
        timestamp: new Date().toISOString(),
        redis: redisReady ? 'connected' : 'disconnected',
      })
    })

    // Seckill public routes - POST /seckill/buy, GET /seckill/status/:productId
    this.app.use('/seckill', seckillRoutes)

    // Admin routes - POST /admin/seckill/init, POST /admin/seckill/release
    this.app.use('/admin/seckill', adminRoutes)

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      logger.error({ error: err.message, stack: err.stack }, 'Unhandled error')
      res.status(err.status || 500).json({
        error: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'development' 
          ? err.message 
          : 'An unexpected error occurred',
      })
    })

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Route not found',
      })
    })
  }

  /**
   * Initialize Redis client and load Lua scripts
   */
  async initRedis() {
    await redisClient.connect()
    await redisClient.loadScripts()
    logger.info('✓ [Seckill] Redis connected and Lua scripts loaded')
  }

  /**
   * Initialize message broker and register consumers
   */
  async setupBroker() {
    try {
      logger.info('⏳ [Seckill] Setting up message broker...')

      // Dynamically import Broker (ES module)
      const { Broker: BrokerClass } = await import('@ecommerce/message-broker')
      Broker = BrokerClass

      // Initialize Broker
      this.broker = new Broker()
      logger.info('✓ [Seckill] Broker initialized')

      // Set message broker on seckill service for event publishing
      seckillService.setMessageBroker(this.broker)
      logger.info('✓ [Seckill] Message broker attached to seckill service')

      // Register release consumer for compensation events
      await registerReleaseConsumer(this.broker)
      logger.info('✓ [Seckill] Release consumer registered')

    } catch (error) {
      logger.error(
        { error: error.message },
        '❌ [Seckill] Failed to setup message broker'
      )
      throw error
    }
  }

  /**
   * Start the application
   */
  async start() {
    try {
      // Initialize Redis and load Lua scripts
      await this.initRedis()

      // Set up middlewares
      this.setMiddlewares()

      // Set up routes
      this.setRoutes()

      // Initialize message broker and consumers
      await this.setupBroker()

      // Start HTTP server
      this.server = this.app.listen(config.port, () => {
        logger.info({ port: config.port }, `✓ [Seckill] Server listening on port ${config.port}`)
      })

      // Graceful shutdown handlers
      process.on('SIGTERM', () => this.shutdown())
      process.on('SIGINT', () => this.shutdown())

    } catch (error) {
      logger.error({ error: error.message }, '❌ [Seckill] Failed to start service')
      throw error
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('⏳ [Seckill] Shutting down...')

    // Close message broker
    if (this.broker) {
      await this.broker.close()
      logger.info('✓ [Seckill] Broker connections closed')
    }

    // Close Redis connection
    await redisClient.close()
    logger.info('✓ [Seckill] Redis connection closed')

    // Close HTTP server
    if (this.server) {
      this.server.close()
      logger.info('✓ [Seckill] Server stopped')
    }

    logger.info('✓ [Seckill] Shutdown complete')
    process.exit(0)
  }

  /**
   * Stop the application (for testing)
   */
  async stop() {
    // Close message broker
    if (this.broker) {
      await this.broker.close()
      logger.info('✓ [Seckill] Broker connections closed')
    }

    // Close Redis connection
    await redisClient.close()
    logger.info('✓ [Seckill] Redis connection closed')

    // Close HTTP server
    if (this.server) {
      this.server.close()
      logger.info('✓ [Seckill] Server stopped')
    }
  }
}

module.exports = App
