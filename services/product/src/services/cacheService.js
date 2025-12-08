/**
 * Redis Cache Service for Product
 * 
 * Provides caching layer for product data to reduce database load.
 * 
 * Cache Strategy:
 * - Cache-Aside (Lazy Loading): Read from cache first, fallback to DB
 * - Write-Through: Invalidate cache on write operations
 * 
 * TTL Strategy:
 * - Product list: 5 minutes (frequently accessed, rarely changes)
 * - Single product: 10 minutes (less frequent, more stable)
 */

const { createClient } = require('redis');
const logger = require('@ecommerce/logger');

// Cache keys
const CACHE_KEYS = {
  ALL_PRODUCTS: 'products:all',
  PRODUCT_BY_ID: (id) => `products:${id}`,
  PRODUCT_COUNT: 'products:count',
};

// TTL in seconds
const TTL = {
  ALL_PRODUCTS: 300,      // 5 minutes
  SINGLE_PRODUCT: 600,    // 10 minutes
  PRODUCT_COUNT: 60,      // 1 minute
};

class CacheService {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  /**
   * Initialize Redis connection
   */
  async connect() {
    if (this.isConnected) return;

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    try {
      this.client = createClient({ url: redisUrl });

      this.client.on('error', (err) => {
        logger.error({ error: err.message }, '[Cache] Redis connection error');
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info({ redisUrl }, '[Cache] Redis connected');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        logger.info('[Cache] Redis reconnecting...');
      });

      await this.client.connect();
      this.isConnected = true;
      logger.info('[Cache] Product cache service initialized');
    } catch (error) {
      logger.error({ error: error.message }, '[Cache] Failed to connect to Redis');
      this.isConnected = false;
    }
  }

  /**
   * Check if cache is available
   */
  isAvailable() {
    return this.isConnected && this.client?.isOpen;
  }

  /**
   * Get all products from cache
   * @returns {Array|null} Products array or null if not cached
   */
  async getAllProducts() {
    if (!this.isAvailable()) return null;

    try {
      const cached = await this.client.get(CACHE_KEYS.ALL_PRODUCTS);
      if (cached) {
        logger.debug('[Cache] HIT - getAllProducts');
        return JSON.parse(cached);
      }
      logger.debug('[Cache] MISS - getAllProducts');
      return null;
    } catch (error) {
      logger.warn({ error: error.message }, '[Cache] Error getting all products');
      return null;
    }
  }

  /**
   * Set all products in cache
   * @param {Array} products - Products array
   */
  async setAllProducts(products) {
    if (!this.isAvailable()) return;

    try {
      await this.client.setEx(
        CACHE_KEYS.ALL_PRODUCTS,
        TTL.ALL_PRODUCTS,
        JSON.stringify(products)
      );
      logger.debug({ count: products.length }, '[Cache] SET - getAllProducts');
    } catch (error) {
      logger.warn({ error: error.message }, '[Cache] Error setting all products');
    }
  }

  /**
   * Get single product from cache
   * @param {string} productId - Product ID
   * @returns {Object|null} Product or null if not cached
   */
  async getProduct(productId) {
    if (!this.isAvailable()) return null;

    try {
      const cached = await this.client.get(CACHE_KEYS.PRODUCT_BY_ID(productId));
      if (cached) {
        logger.debug({ productId }, '[Cache] HIT - getProduct');
        return JSON.parse(cached);
      }
      logger.debug({ productId }, '[Cache] MISS - getProduct');
      return null;
    } catch (error) {
      logger.warn({ error: error.message, productId }, '[Cache] Error getting product');
      return null;
    }
  }

  /**
   * Set single product in cache
   * @param {string} productId - Product ID
   * @param {Object} product - Product data
   */
  async setProduct(productId, product) {
    if (!this.isAvailable()) return;

    try {
      await this.client.setEx(
        CACHE_KEYS.PRODUCT_BY_ID(productId),
        TTL.SINGLE_PRODUCT,
        JSON.stringify(product)
      );
      logger.debug({ productId }, '[Cache] SET - product');
    } catch (error) {
      logger.warn({ error: error.message, productId }, '[Cache] Error setting product');
    }
  }

  /**
   * Invalidate product cache (on create/update/delete)
   * @param {string} productId - Product ID (optional, if provided also invalidates single product)
   */
  async invalidate(productId = null) {
    if (!this.isAvailable()) return;

    try {
      // Always invalidate the all products list
      await this.client.del(CACHE_KEYS.ALL_PRODUCTS);
      await this.client.del(CACHE_KEYS.PRODUCT_COUNT);

      // If productId provided, also invalidate single product cache
      if (productId) {
        await this.client.del(CACHE_KEYS.PRODUCT_BY_ID(productId));
      }

      logger.debug({ productId }, '[Cache] INVALIDATED - product cache');
    } catch (error) {
      logger.warn({ error: error.message }, '[Cache] Error invalidating cache');
    }
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    if (!this.isAvailable()) {
      return { available: false };
    }

    try {
      const info = await this.client.info('stats');
      const keys = await this.client.keys('products:*');
      return {
        available: true,
        cachedKeys: keys.length,
        info: info.split('\n').slice(0, 10).join('\n'),
      };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  /**
   * Close Redis connection
   */
  async close() {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
      logger.info('[Cache] Redis connection closed');
    }
  }
}

// Singleton instance
const cacheService = new CacheService();

module.exports = cacheService;
