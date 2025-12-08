/**
 * Product Service - Business Metrics
 * 
 * Metrics specific to product operations
 */

const { promClient } = require('@ecommerce/metrics');

// Product CRUD operations counter
const productOperations = new promClient.Counter({
  name: 'product_operations_total',
  help: 'Product CRUD operations',
  labelNames: ['operation', 'status'] // operation: create, read, update, delete; status: success, failed, not_found
});

// Product search/query duration histogram
const productSearchDuration = new promClient.Histogram({
  name: 'product_search_duration_seconds',
  help: 'Product search/query duration',
  labelNames: ['search_type'], // by_id, by_category, list_all, full_text
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

// Total products gauge
const totalProducts = new promClient.Gauge({
  name: 'product_total_count',
  help: 'Total number of products in database'
});

// Products by category gauge
const productsByCategory = new promClient.Gauge({
  name: 'product_by_category',
  help: 'Number of products by category',
  labelNames: ['category']
});

// Inventory sync operations counter
const inventorySyncOperations = new promClient.Counter({
  name: 'product_inventory_sync_total',
  help: 'Product-Inventory synchronization operations',
  labelNames: ['operation', 'status'] // operation: create, delete; status: success, failed
});

// Inventory sync duration histogram
const inventorySyncDuration = new promClient.Histogram({
  name: 'product_inventory_sync_duration_seconds',
  help: 'Duration of inventory sync operations',
  labelNames: ['operation'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

// Cache hit/miss counter
const cacheOperations = new promClient.Counter({
  name: 'product_cache_operations_total',
  help: 'Product cache hit/miss operations',
  labelNames: ['operation', 'result'] // operation: list_all, by_id; result: hit, miss
});

/**
 * Record a product operation
 * @param {'create'|'read'|'update'|'delete'} operation 
 * @param {'success'|'failed'|'not_found'} status 
 */
function recordProductOperation(operation, status) {
  productOperations.inc({ operation, status });
}

/**
 * Start a timer for product search/query
 * @param {'by_id'|'by_category'|'list_all'|'full_text'} searchType 
 * @returns {function} End timer function
 */
function startSearchTimer(searchType) {
  return productSearchDuration.startTimer({ search_type: searchType });
}

/**
 * Update total product count
 * @param {number} count 
 */
function setTotalProducts(count) {
  totalProducts.set(count);
}

/**
 * Update product count by category
 * @param {string} category 
 * @param {number} count 
 */
function setProductsByCategory(category, count) {
  productsByCategory.set({ category }, count);
}

/**
 * Record inventory sync operation
 * @param {'create'|'delete'} operation 
 * @param {'success'|'failed'} status 
 */
function recordInventorySync(operation, status) {
  inventorySyncOperations.inc({ operation, status });
}

/**
 * Start a timer for inventory sync operation
 * @param {'create'|'delete'} operation 
 * @returns {function} End timer function
 */
function startInventorySyncTimer(operation) {
  return inventorySyncDuration.startTimer({ operation });
}

/**
 * Record cache hit
 * @param {'list_all'|'by_id'} operation 
 */
function recordCacheHit(operation) {
  cacheOperations.inc({ operation, result: 'hit' });
}

/**
 * Record cache miss
 * @param {'list_all'|'by_id'} operation 
 */
function recordCacheMiss(operation) {
  cacheOperations.inc({ operation, result: 'miss' });
}

/**
 * Update product counts from database
 * @param {import('mongoose').Model} ProductModel 
 */
async function updateProductCounts(ProductModel) {
  try {
    // Total count
    const total = await ProductModel.countDocuments();
    setTotalProducts(total);

    // Count by category
    const categoryCounts = await ProductModel.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);
    
    categoryCounts.forEach(({ _id, count }) => {
      if (_id) {
        setProductsByCategory(_id, count);
      }
    });
  } catch (err) {
    // Silently fail - metrics update should not break the app
    console.error('[Metrics] Failed to update product counts:', err.message);
  }
}

module.exports = {
  // Metrics
  productOperations,
  productSearchDuration,
  totalProducts,
  productsByCategory,
  inventorySyncOperations,
  inventorySyncDuration,
  cacheOperations,

  // Helper functions
  recordProductOperation,
  startSearchTimer,
  setTotalProducts,
  setProductsByCategory,
  recordInventorySync,
  startInventorySyncTimer,
  updateProductCounts,
  recordCacheHit,
  recordCacheMiss,
};
