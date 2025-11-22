const inventoryRepository = require("../repositories/inventoryRepository");
const logger = require("@ecommerce/logger");
const mongoose = require("mongoose");

/**
 * Service layer for inventory business logic
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
   * Reserve inventory for an order
   * @returns {Object} { success: boolean, inventory: Object }
   */
  async reserveStock(productId, quantity) {
    try {
      // Use an atomic reserve operation to prevent race conditions
      const updated = await inventoryRepository.reserveIfAvailable(
        productId,
        quantity
      );

      if (!updated) {
        const current = await inventoryRepository.findByProductId(productId);
        return {
          success: false,
          message: `Insufficient stock. Available: ${current ? current.available : 0
            }, Requested: ${quantity}`,
          inventory: current,
        };
      }

      logger.info(
        `[InventoryService] Reserved ${quantity} units for product ${productId}`
      );

      return {
        success: true,
        message: `Successfully reserved ${quantity} units`,
        inventory: updated,
      };
    } catch (error) {
      logger.error(
        `[InventoryService] Error reserving stock: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Reserve inventory for multiple products in a single batch operation
   * @param {Array<{productId: string, quantity: number}>} products
   */
  async reserveStockBatch(products) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      // Use single bulkWrite operation instead of N queries
      const result = await inventoryRepository.reserveStockBatch(products, session);

      if (!result.success) {
        throw new Error(result.message);
      }

      await session.commitTransaction();

      logger.info(
        `[InventoryService] Successfully reserved stock for ${products.length} products in single batch operation`
      );

      return {
        success: true,
        message: `All ${products.length} products reserved successfully`,
        modifiedCount: result.modifiedCount
      };
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
   */
  async releaseReserved(productId, quantity) {
    try {
      const inventory = await inventoryRepository.findByProductId(productId);

      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }

      if (inventory.reserved < quantity) {
        throw new Error(
          `Cannot release ${quantity} units. Only ${inventory.reserved} units are reserved`
        );
      }

      // Release reserved stock back to available
      const updated = await inventoryRepository.updateByProductId(productId, {
        $inc: {
          available: quantity,
          reserved: -quantity,
        },
      });

      logger.info(
        `[InventoryService] Released ${quantity} reserved units for product ${productId}`
      );
      return updated;
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
   */
  async restockInventory(productId, quantity) {
    try {
      if (quantity <= 0) {
        throw new Error("Restock quantity must be greater than 0");
      }

      const inventory = await inventoryRepository.findByProductId(productId);

      if (!inventory) {
        throw new Error("Inventory not found for this product");
      }

      // Add to available stock
      const updated = await inventoryRepository.updateByProductId(productId, {
        $inc: { available: quantity },
        lastRestockedAt: new Date(),
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
   */
  async adjustInventory(productId, availableDelta, reservedDelta = 0) {
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

      const updated = await inventoryRepository.updateByProductId(productId, {
        $inc: {
          available: availableDelta,
          reserved: reservedDelta,
        },
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
}

module.exports = new InventoryService();
