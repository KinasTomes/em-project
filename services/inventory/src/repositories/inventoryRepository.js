const Inventory = require("../models/inventory");
const logger = require("@ecommerce/logger");
const mongoose = require("mongoose");

const normalizeProductId = (productId) => {
  if (productId instanceof mongoose.Types.ObjectId) {
    return productId;
  }
  if (
    typeof productId === "string" &&
    mongoose.Types.ObjectId.isValid(productId)
  ) {
    return new mongoose.Types.ObjectId(productId);
  }
  throw new Error("Invalid productId");
};

/**
 * Repository layer for Inventory operations
 * Handles all database interactions
 */
class InventoryRepository {
  /**
   * Find inventory by product ID
   */
  async findByProductId(productId) {
    try {
      const normalizedId = normalizeProductId(productId);
      return await Inventory.findOne({ productId: normalizedId });
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error finding inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Create new inventory record
   */
  async create(inventoryData) {
    try {
      const normalizedId = normalizeProductId(inventoryData.productId);
      const inventory = new Inventory({
        ...inventoryData,
        productId: normalizedId,
      });
      return await inventory.save();
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error creating inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Update inventory by product ID
   */
  async updateByProductId(productId, updateData) {
    try {
      const normalizedId = normalizeProductId(productId);
      return await Inventory.findOneAndUpdate(
        { productId: normalizedId },
        updateData,
        {
          new: true,
          runValidators: true,
        }
      );
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error updating inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Atomically reserve stock if available. Returns the updated document when success, otherwise null.
   */
  async reserveIfAvailable(productId, quantity, session = null) {
    try {
      const normalizedId = normalizeProductId(productId);
      const options = { new: true };
      if (session) {
        options.session = session;
      }
      const updated = await Inventory.findOneAndUpdate(
        { productId: normalizedId, available: { $gte: quantity } },
        { $inc: { available: -quantity, reserved: quantity } },
        options
      );
      return updated; // null if not enough available
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error reserving inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get all inventory records with pagination
   */
  async findAll(page = 1, limit = 50) {
    try {
      const skip = (page - 1) * limit;
      const [items, total] = await Promise.all([
        Inventory.find().skip(skip).limit(limit).sort({ createdAt: -1 }),
        Inventory.countDocuments(),
      ]);
      return {
        items,
        total,
        page,
        pages: Math.ceil(total / limit),
      };
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error finding all inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get low stock items
   */
  async findLowStock(threshold = 10) {
    try {
      return await Inventory.getLowStock(threshold);
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error finding low stock: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Get out of stock items
   */
  async findOutOfStock() {
    try {
      return await Inventory.getOutOfStock();
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error finding out of stock: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Delete inventory by product ID
   */
  async deleteByProductId(productId) {
    try {
      const normalizedId = normalizeProductId(productId);
      return await Inventory.findOneAndDelete({ productId: normalizedId });
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error deleting inventory: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Bulk create or update inventory
   */
  async bulkUpsert(inventoryItems) {
    try {
      const operations = inventoryItems.map((item) => ({
        updateOne: {
          filter: { productId: normalizeProductId(item.productId) },
          update: { $set: item },
          upsert: true,
        },
      }));
      return await Inventory.bulkWrite(operations);
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error bulk upserting: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Atomically reserve stock for multiple products in a single operation
   * Uses optimistic approach - check availability BEFORE bulkWrite to avoid race condition
   * @param {Array<{productId: string, quantity: number}>} products
   * @param {Object} session - MongoDB session for transaction
   * @returns {Object} { success: boolean, failedProduct?: string, previousValues?: Object }
   */
  async reserveStockBatch(products, session = null) {
    try {
      const options = session ? { session } : {};
      
      // STEP 1: Pre-check availability atomically within the same session/transaction
      // This prevents the race condition where we check after bulkWrite fails
      const productIds = products.map(p => normalizeProductId(p.productId));
      const currentInventories = await Inventory.find(
        { productId: { $in: productIds } },
        null,
        options
      );

      // Build a map for quick lookup
      const inventoryMap = new Map();
      for (const inv of currentInventories) {
        inventoryMap.set(inv.productId.toString(), inv);
      }

      // Check each product has sufficient stock
      const previousValues = {};
      for (const { productId, quantity } of products) {
        const normalizedId = normalizeProductId(productId).toString();
        const inventory = inventoryMap.get(normalizedId);
        
        if (!inventory) {
          return {
            success: false,
            failedProduct: productId,
            message: `Inventory not found for product ${productId}`
          };
        }

        if (inventory.available < quantity) {
          return {
            success: false,
            failedProduct: productId,
            message: `Insufficient stock for product ${productId}. Available: ${inventory.available}, Requested: ${quantity}`
          };
        }

        // Store previous values for audit log
        previousValues[productId] = {
          available: inventory.available,
          reserved: inventory.reserved,
        };
      }

      // STEP 2: All checks passed, perform the atomic update
      const operations = products.map(({ productId, quantity }) => ({
        updateOne: {
          filter: {
            productId: normalizeProductId(productId),
            available: { $gte: quantity }
          },
          update: {
            $inc: { available: -quantity, reserved: quantity }
          }
        }
      }));

      const result = await Inventory.bulkWrite(operations, options);

      // Verify all operations succeeded
      if (result.modifiedCount !== products.length) {
        // This should rarely happen since we pre-checked, but handle it
        return {
          success: false,
          message: `Batch reserve partially failed: ${result.modifiedCount}/${products.length} products updated (concurrent modification detected)`
        };
      }

      return { 
        success: true, 
        modifiedCount: result.modifiedCount,
        previousValues, // Return for audit logging
      };
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error in batch reserve: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Atomically release stock for multiple products
   * @param {Array<{productId: string, quantity: number}>} products
   * @param {Object} session - MongoDB session for transaction
   * @returns {Object} { success: boolean, previousValues?: Object }
   */
  async releaseStockBatch(products, session = null) {
    try {
      const options = session ? { session } : {};
      
      // Get current values for audit log
      const productIds = products.map(p => normalizeProductId(p.productId));
      const currentInventories = await Inventory.find(
        { productId: { $in: productIds } },
        null,
        options
      );

      const inventoryMap = new Map();
      for (const inv of currentInventories) {
        inventoryMap.set(inv.productId.toString(), inv);
      }

      const previousValues = {};
      for (const { productId } of products) {
        const normalizedId = normalizeProductId(productId).toString();
        const inventory = inventoryMap.get(normalizedId);
        if (inventory) {
          previousValues[productId] = {
            available: inventory.available,
            reserved: inventory.reserved,
          };
        }
      }

      const operations = products.map(({ productId, quantity }) => ({
        updateOne: {
          filter: {
            productId: normalizeProductId(productId),
            reserved: { $gte: quantity }
          },
          update: {
            $inc: { available: quantity, reserved: -quantity }
          }
        }
      }));

      const result = await Inventory.bulkWrite(operations, options);

      return { 
        success: true, 
        modifiedCount: result.modifiedCount,
        previousValues,
      };
    } catch (error) {
      logger.error(
        `[InventoryRepository] Error in batch release: ${error.message}`
      );
      throw error;
    }
  }
}

module.exports = new InventoryRepository();

module.exports = new InventoryRepository();
