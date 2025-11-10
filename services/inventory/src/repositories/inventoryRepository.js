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
  async reserveIfAvailable(productId, quantity) {
    try {
      const normalizedId = normalizeProductId(productId);
      const updated = await Inventory.findOneAndUpdate(
        { productId: normalizedId, available: { $gte: quantity } },
        { $inc: { available: -quantity, reserved: quantity } },
        { new: true }
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
}

module.exports = new InventoryRepository();
