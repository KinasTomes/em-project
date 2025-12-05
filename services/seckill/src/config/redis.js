const { createClient } = require('redis')
const fs = require('fs')
const path = require('path')
const logger = require('@ecommerce/logger')
const config = require('./index')

class RedisClient {
  constructor() {
    this.client = null
    this.scriptSHAs = {}
    this.isConnected = false
  }

  /**
   * Connect to Redis
   */
  async connect() {
    if (this.isConnected) {
      return
    }

    this.client = createClient({
      url: config.redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error('Redis max reconnection attempts reached')
            return new Error('Max reconnection attempts reached')
          }
          return Math.min(retries * 100, 3000)
        }
      }
    })

    this.client.on('error', (err) => {
      logger.error({ error: err.message }, 'Redis client error')
    })

    this.client.on('connect', () => {
      logger.info('Redis client connected')
    })

    this.client.on('reconnecting', () => {
      logger.warn('Redis client reconnecting...')
    })

    await this.client.connect()
    this.isConnected = true
  }

  /**
   * Load Lua scripts and cache their SHA hashes
   * @returns {Object} Object containing script SHA hashes
   */
  async loadScripts() {
    const scriptsDir = path.join(__dirname, '..', 'scripts')
    
    const scripts = {
      reserve: 'seckill-reserve.lua',
      release: 'seckill-release.lua'
    }

    for (const [name, filename] of Object.entries(scripts)) {
      const scriptPath = path.join(scriptsDir, filename)
      
      if (!fs.existsSync(scriptPath)) {
        logger.warn({ script: filename }, 'Lua script not found, skipping')
        continue
      }

      const script = fs.readFileSync(scriptPath, 'utf8')
      const sha = await this.client.scriptLoad(script)
      this.scriptSHAs[name] = sha
      logger.info({ script: name, sha }, 'Lua script loaded')
    }

    return this.scriptSHAs
  }

  /**
   * Execute a Lua script using EVALSHA
   * @param {string} scriptName - Name of the script (reserve, release)
   * @param {Object} options - Options containing keys and arguments
   * @param {string[]} options.keys - Redis keys
   * @param {string[]} options.arguments - Script arguments
   * @returns {Promise<number>} Script result
   */
  async evalSha(scriptName, { keys = [], arguments: args = [] } = {}) {
    const sha = this.scriptSHAs[scriptName]
    
    if (!sha) {
      throw new Error(`Script '${scriptName}' not loaded`)
    }

    try {
      const result = await this.client.evalSha(sha, {
        keys,
        arguments: args
      })
      return result
    } catch (error) {
      // If script not found in cache, reload and retry
      if (error.message.includes('NOSCRIPT')) {
        logger.warn({ script: scriptName }, 'Script not in cache, reloading...')
        await this.loadScripts()
        return this.client.evalSha(this.scriptSHAs[scriptName], {
          keys,
          arguments: args
        })
      }
      throw error
    }
  }

  /**
   * Get a value from Redis
   * @param {string} key - Redis key
   * @returns {Promise<string|null>}
   */
  async get(key) {
    return this.client.get(key)
  }

  /**
   * Set a value in Redis
   * @param {string} key - Redis key
   * @param {string} value - Value to set
   * @param {Object} options - Optional settings (EX, PX, etc.)
   */
  async set(key, value, options = {}) {
    return this.client.set(key, value, options)
  }

  /**
   * Delete a key from Redis
   * @param {string} key - Redis key
   */
  async del(key) {
    return this.client.del(key)
  }

  /**
   * Add member to a set
   * @param {string} key - Set key
   * @param {string} member - Member to add
   */
  async sAdd(key, member) {
    return this.client.sAdd(key, member)
  }

  /**
   * Check if member exists in set
   * @param {string} key - Set key
   * @param {string} member - Member to check
   */
  async sIsMember(key, member) {
    return this.client.sIsMember(key, member)
  }

  /**
   * Get all members of a set
   * @param {string} key - Set key
   */
  async sMembers(key) {
    return this.client.sMembers(key)
  }

  /**
   * Increment a value
   * @param {string} key - Redis key
   */
  async incr(key) {
    return this.client.incr(key)
  }

  /**
   * Decrement a value
   * @param {string} key - Redis key
   */
  async decr(key) {
    return this.client.decr(key)
  }

  /**
   * Execute multiple commands in a pipeline
   * @param {Function} callback - Function that receives the pipeline
   */
  async multi(callback) {
    const multi = this.client.multi()
    callback(multi)
    return multi.exec()
  }

  /**
   * Close the Redis connection
   */
  async close() {
    if (this.client && this.isConnected) {
      await this.client.quit()
      this.isConnected = false
      logger.info('Redis connection closed')
    }
  }

  /**
   * Get the underlying Redis client (for advanced operations)
   */
  getClient() {
    return this.client
  }

  /**
   * Check if connected
   */
  isReady() {
    return this.isConnected && this.client?.isReady
  }
}

// Export singleton instance
module.exports = new RedisClient()
