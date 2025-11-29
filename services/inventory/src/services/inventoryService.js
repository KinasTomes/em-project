const inventoryRepository = require("../repositories/inventoryRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const logger = require("@ecommerce/logger");
const mongoose = require("mongoose");

// Distributed lock service (injected from app.js)
let distributedLockService = null;

/**
 * Set the distributed lock service instance
 * @param {DistributedLockService} lockService
 */
function setDistributedLockService(lockService) {
  distributedLockService = lockService;
}

/**
 * Service layer for inventory business logic
 * Includes distributed locking and audit logging
 */
class InventoryService {
  /**
   * Get inventory by product ID
   */
  async getInventoryByProductId(productId) {
    try {
      const inventory = await inventoryRepository.findByProductId(productId);
      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }
      return inventory;
    } catch (error) {
      logger.error(
        `[InventoryService] Error getting inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Create or initialize inventory for a product
   */
  async createInventory(productId, available = 0) {
    try {
      // Normalize incoming available value
      const availableParsed = Number(available);
      const availableNormalized =
        Number.isFinite(availableParsed) && availableParsed >= 0
          ? Math.floor(availableParsed)
          : 0;

      // Check if inventory already exists
      const existing = await inventoryRepository.findByProductId(productId);
      if (existing) {
        logger.info(
          `[InventoryService] Inventory already exists for ${productId}`
        );
        // If available provided and greater than 0, restock (idempotent upsert behavior)
        if (availableNormalized > 0) {
          const updated = await this.restockInventory(
            productId,
            availableNormalized
          );
          return updated;
        }
        return existing;
      }

      const inventory = await inventoryRepository.create({
        productId,
        available: availableNormalized,
        reserved: 0,
        backorder: 0,
      });

      if (inventory.available !== availableNormalized) {
        logger.error(
          `[InventoryService] Persisted availability mismatch for product ${productId}: expected ${availableNormalized}, got ${inventory.available}`
        );
      }

      logger.info(
        `[InventoryService] Created inventory for product ${productId} with available ${availableNormalized}`
      );
      return inventory;
    } catch (error) {
      logger.error(
        `[InventoryService] Error creating inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Reserve inventory for an order (single product)
   * Uses distributed lock to prevent race conditions across instances
   * @param {string} productId
   * @param {number} quantity
   * @param {Object} options - { orderId, correlationId }
   * @returns {Object} { success: boolean, inventory: Object }
   */
  async reserveStock(productId, quantity, options = {}) {
    const { orderId, correlationId } = options;

    // Use distributed lock if available
    const executeReserve = async () => {
      // Get current state for audit
      const current = await inventoryRepository.findByProductId(productId);
      if (!current) {
        return {
          success: false,
          message: `Inventory not found for product ${productId}`,
          inventory: null,
        };
      }

      const previousValue = {
        available: current.available,
        reserved: current.reserved,
      };

      // Use an atomic reserve operation
      const updated = await inventoryRepository.reserveIfAvailable(
        productId,
        quantity
      );

      if (!updated) {
        return {
          success: false,
          message: `Insufficient stock. Available: ${current.available}, Requested: ${quantity}`,
          inventory: current,
        };
      }

      // Create audit log
      await auditLogRepository.create({
        productId,
        action: 'RESERVE',
        previousValue,
        newValue: {
          available: updated.available,
          reserved: updated.reserved,
        },
        reason: 'ORDER_RESERVE',
        orderId,
        correlationId,
      });

      logger.info(
        `[InventoryService] Reserved ${quantity} units for product ${productId}`
      );

      return {
        success: true,
        message: `Successfully reserved ${quantity} units`,
        inventory: updated,
      };
    };

    try {
      if (distributedLockService) {
        return await distributedLockService.withLock(
          'product',
          productId,
          executeReserve,
          5000 // 5 second lock TTL
        );
      }
      return await executeReserve();
    } catch (error) {
      logger.error(
        `[InventoryService] Error reserving stock: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Reserve inventory for multiple products in a single batch operation
   * Uses distributed lock for the entire batch to prevent race conditions
   * @param {Array<{productId: string, quantity: number}>} products
   * @param {Object} externalSession - Optional external MongoDB session for transactional outbox
   * @param {Object} options - { orderId, correlationId }
   */
  async reserveStockBatch(products, externalSession = null, options = {}) {
    const { orderId, correlationId } = options;

    const executeReserveBatch = async (session) => {
      const result = await inventoryRepository.reserveStockBatch(products, session);

      if (!result.success) {
        return {
          success: false,
          message: result.message,
        };
      }

      // Create audit logs for each product
      if (result.previousValues) {
        for (const { productId, quantity } of products) {
          const prev = result.previousValues[productId];
          if (prev) {
            await auditLogRepository.create({
              productId,
              action: 'RESERVE',
              previousValue: prev,
              newValue: {
                available: prev.available - quantity,
                reserved: prev.reserved + quantity,
              },
              reason: 'ORDER_RESERVE',
              orderId,
              correlationId,
            }, session);
          }
        }
      }

      logger.info(
        `[InventoryService] Successfully reserved stock for ${products.length} products`
      );

      return {
        success: true,
        message: `All ${products.length} products reserved successfully`,
        modifiedCount: result.modifiedCount
      };
    };

    // If external session provided, use it (for transactional outbox)
    if (externalSession) {
      try {
        return await executeReserveBatch(externalSession);
      } catch (error) {
        logger.warn(
          `[InventoryService] Batch reservation failed: ${error.message}`
        );
        return {
          success: false,
          message: error.message,
        };
      }
    }

    // Otherwise, create own session with distributed lock
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const result = await executeReserveBatch(session);

      if (!result.success) {
        await session.abortTransaction();
        return result;
      }

      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction();
      logger.warn(
        `[InventoryService] Batch reservation failed: ${error.message}`
      );
      return {
        success: false,
        message: error.message,
      };
    } finally {
      session.endSession();
    }
  }

  /**
   * Release reserved inventory (e.g., when order is cancelled)
   * Uses distributed lock and creates audit log
   * @param {string} productId
   * @param {number} quantity
   * @param {Object} options - { orderId, correlationId, reason }
   */
  async releaseReserved(productId, quantity, options = {}) {
    const { orderId, correlationId, reason = 'ORDER_CANCEL' } = options;

    const executeRelease = async () => {
      const inventory = await inventoryRepository.findByProductId(productId);

      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }

      if (inventory.reserved < quantity) {
        throw new Error(
          `Cannot release ${quantity} units. Only ${inventory.reserved} units are reserved`
        );
      }

      const previousValue = {
        available: inventory.available,
        reserved: inventory.reserved,
      };

      // Release reserved stock back to available
      const updated = await inventoryRepository.updateByProductId(productId, {
        $inc: {
          available: quantity,
          reserved: -quantity,
        },
      });

      // Create audit log
      await auditLogRepository.create({
        productId,
        action: 'RELEASE',
        previousValue,
        newValue: {
          available: updated.available,
          reserved: updated.reserved,
        },
        reason,
        orderId,
        correlationId,
      });

      logger.info(
        `[InventoryService] Released ${quantity} reserved units for product ${productId}`
      );
      return updated;
    };

    try {
      if (distributedLockService) {
        return await distributedLockService.withLock(
          'product',
          productId,
          executeRelease,
          5000
        );
      }
      return await executeRelease();
    } catch (error) {
      logger.error(
        `[InventoryService] Error releasing reserved stock: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Confirm order fulfillment (decrease reserved stock)
   */
  async confirmFulfillment(productId, quantity) {
    try {
      const inventory = await inventoryRepository.findByProductId(productId);

      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }

      if (inventory.reserved < quantity) {
        throw new Error(
          `Cannot confirm ${quantity} units. Only ${inventory.reserved} units are reserved`
        );
      }

      // Decrease reserved stock (order is fulfilled)
      const updated = await inventoryRepository.updateByProductId(productId, {
        $inc: {
          reserved: -quantity,
        },
      });

      logger.info(
        `[InventoryService] Confirmed fulfillment of ${quantity} units for product ${productId}`
      );
      return updated;
    } catch (error) {
      logger.error(
        `[InventoryService] Error confirming fulfillment: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Restock inventory (add stock)
   * @param {string} productId
   * @param {number} quantity
   * @param {Object} options - { userId, correlationId }
   */
  async restockInventory(productId, quantity, options = {}) {
    const { userId, correlationId } = options;

    try {
      if (quantity <= 0) {
        throw new Error("Restock quantity must be greater than 0");
      }

      const inventory = await inventoryRepository.findByProductId(productId);

      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }

      const previousValue = {
        available: inventory.available,
        reserved: inventory.reserved,
      };

      // Add to available stock
      const updated = await inventoryRepository.updateByProductId(productId, {
        $inc: { available: quantity },
        lastRestockedAt: new Date(),
      });

      // Create audit log
      await auditLogRepository.create({
        productId,
        action: 'RESTOCK',
        previousValue,
        newValue: {
          available: updated.available,
          reserved: updated.reserved,
        },
        reason: 'MANUAL_RESTOCK',
        userId,
        correlationId,
      });

      logger.info(
        `[InventoryService] Restocked ${quantity} units for product ${productId}`
      );
      return updated;
    } catch (error) {
      logger.error(`[InventoryService] Error restocking: ${error.message}`);
      throw error;
    }
  }

  /**
   * Adjust inventory (manual adjustment by admin)
   * @param {string} productId
   * @param {number} availableDelta
   * @param {number} reservedDelta
   * @param {Object} options - { userId, correlationId, metadata }
   */
  async adjustInventory(productId, availableDelta, reservedDelta = 0, options = {}) {
    const { userId, correlationId, metadata } = options;

    try {
      const inventory = await inventoryRepository.findByProductId(productId);

      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }

      const newAvailable = inventory.available + availableDelta;
      const newReserved = inventory.reserved + reservedDelta;

      if (newAvailable < 0 || newReserved < 0) {
        throw new Error("Adjustment would result in negative stock");
      }

      const previousValue = {
        available: inventory.available,
        reserved: inventory.reserved,
      };

      const updated = await inventoryRepository.updateByProductId(productId, {
        $inc: {
          available: availableDelta,
          reserved: reservedDelta,
        },
      });

      // Create audit log
      await auditLogRepository.create({
        productId,
        action: 'ADJUST',
        previousValue,
        newValue: {
          available: updated.available,
          reserved: updated.reserved,
        },
        reason: 'MANUAL_ADJUST',
        userId,
        correlationId,
        metadata,
      });

      logger.info(
        `[InventoryService] Adjusted inventory for product ${productId}`
      );
      return updated;
    } catch (error) {
      logger.error(
        `[InventoryService] Error adjusting inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get all inventory with pagination
   */
  async getAllInventory(page = 1, limit = 50) {
    try {
      return await inventoryRepository.findAll(page, limit);
    } catch (error) {
      logger.error(
        `[InventoryService] Error getting all inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get low stock alerts
   */
  async getLowStockAlerts(threshold = 10) {
    try {
      return await inventoryRepository.findLowStock(threshold);
    } catch (error) {
      logger.error(
        `[InventoryService] Error getting low stock alerts: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get out of stock products
   */
  async getOutOfStock() {
    try {
      return await inventoryRepository.findOutOfStock();
    } catch (error) {
      logger.error(
        `[InventoryService] Error getting out of stock items: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Check stock availability for multiple products
   */
  async checkAvailability(productIds) {
    try {
      const checks = await Promise.all(
        productIds.map(async (productId) => {
          const inventory = await inventoryRepository.findByProductId(
            productId
          );
          return {
            productId,
            available: inventory ? inventory.available : 0,
            inStock: inventory ? inventory.isInStock() : false,
          };
        })
      );
      return checks;
    } catch (error) {
      logger.error(
        `[InventoryService] Error checking availability: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Delete inventory for a product
   */
  async deleteInventory(productId) {
    try {
      const inventory = await inventoryRepository.deleteByProductId(productId);
      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }

      // Create audit log for deletion
      await auditLogRepository.create({
        productId,
        action: 'DELETE',
        previousValue: {
          available: inventory.available,
          reserved: inventory.reserved,
        },
        newValue: { available: 0, reserved: 0 },
        reason: 'PRODUCT_DELETED',
      });

      logger.info(
        `[InventoryService] Deleted inventory for product ${productId}`
      );
      return inventory;
    } catch (error) {
      logger.error(
        `[InventoryService] Error deleting inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get audit history for a product
   * @param {string} productId
   * @param {number} limit
   */
  async getAuditHistory(productId, limit = 100) {
    try {
      return await auditLogRepository.getProductHistory(productId, limit);
    } catch (error) {
      logger.error(
        `[InventoryService] Error getting audit history: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get audit history for an order
   * @param {string} orderId
   */
  async getOrderAuditHistory(orderId) {
    try {
      return await auditLogRepository.getOrderHistory(orderId);
    } catch (error) {
      logger.error(
        `[InventoryService] Error getting order audit history: ${error.message}`
      );
      throw error;
    }
  }
}

const inventoryService = new InventoryService();

module.exports = inventoryService;
module.exports.setDistributedLockService = setDistributedLockService;
