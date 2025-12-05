const express = require('express')
const logger = require('@ecommerce/logger')
const config = require('./config')
const redisClient = require('./config/redis')

class App {
  constructor() {
    this.app = express()
    this.setupMiddleware()
  }

  setupMiddleware() {
    this.app.use(express.json())
    
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: config.serviceName })
    })
  }

  async start() {
    try {
      // Connect to Redis and load Lua scripts
      await redisClient.connect()
      await redisClient.loadScripts()
      logger.info('Redis connected and Lua scripts loaded')

      // Start HTTP server
      this.server = this.app.listen(config.port, () => {
        logger.info({ port: config.port }, `${config.serviceName} listening on port ${config.port}`)
      })

      // Graceful shutdown
      process.on('SIGTERM', () => this.shutdown())
      process.on('SIGINT', () => this.shutdown())

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to start seckill service')
      throw error
    }
  }

  async shutdown() {
    logger.info('Shutting down seckill service...')
    
    if (this.server) {
      this.server.close()
    }
    
    await redisClient.close()
    
    logger.info('Seckill service shut down complete')
    process.exit(0)
  }
}

module.exports = App
