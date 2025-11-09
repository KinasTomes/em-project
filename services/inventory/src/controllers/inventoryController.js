const inventoryService = require("../services/inventoryService");
const logger = require("@ecommerce/logger");

/**
 * Controller for inventory management
 */
class InventoryController {
  /**
   * GET /api/inventory
   * Get all inventory with pagination
   */
  async getAllInventory(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;

      const result = await inventoryService.getAllInventory(page, limit);

      res.status(200).json(result);
    } catch (error) {
      logger.error(
        `[InventoryController] Error getting all inventory: ${error.message}`
      );
      res.status(500).json({ message: error.message });
    }
  }

  /**
   * GET /api/inventory/:productId
   * Get inventory for specific product
   */
  async getInventoryByProductId(req, res, next) {
    try {
      const { productId } = req.params;
      const inventory = await inventoryService.getInventoryByProductId(
        productId
      );

      res.status(200).json(inventory);
    } catch (error) {
      logger.error(
        `[InventoryController] Error getting inventory: ${error.message}`
      );
      const status = error.message.includes("not found") ? 404 : 500;
      res.status(status).json({ message: error.message });
    }
  }

  /**
   * POST /api/inventory
   * Create new inventory record
   */
  async createInventory(req, res, next) {
    try {
      const { productId } = req.body;
      // Prefer 'available', fallback to legacy 'initialStock'
      const rawAvailable =
        typeof req.body.available !== "undefined"
          ? req.body.available
          : typeof req.body.initialStock !== "undefined"
          ? req.body.initialStock
          : undefined;

      if (!productId) {
        return res.status(400).json({ message: "productId is required" });
      }

      const parsed = Number(rawAvailable);
      const available =
        Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;

      logger.info(
        `[InventoryController] createInventory productId=${productId} rawAvailable=${rawAvailable} normalized=${available}`
      );
      logger.debug(
        `[InventoryController] full body received: ${JSON.stringify(req.body)}`
      );

      const inventory = await inventoryService.createInventory(
        productId,
        available
      );

      res.status(201).json(inventory);
    } catch (error) {
      logger.error(
        `[InventoryController] Error creating inventory: ${error.message}`
      );
      const status = error.message.includes("already exists") ? 409 : 500;
      res.status(status).json({ message: error.message });
    }
  }

  /**
   * POST /api/inventory/:productId/reserve
   * Reserve stock for an order
   */
  async reserveStock(req, res, next) {
    try {
      const { productId } = req.params;
      const { quantity } = req.body;

      if (!quantity || quantity <= 0) {
        return res.status(400).json({ message: "Valid quantity is required" });
      }

      const result = await inventoryService.reserveStock(productId, quantity);

      if (!result.success) {
        return res.status(409).json(result);
      }

      res.status(200).json(result);
    } catch (error) {
      logger.error(
        `[InventoryController] Error reserving stock: ${error.message}`
      );
      const status = error.message.includes("not found") ? 404 : 500;
      res.status(status).json({ message: error.message });
    }
  }

  /**
   * POST /api/inventory/:productId/release
   * Release reserved stock
   */
  async releaseReserved(req, res, next) {
    try {
      const { productId } = req.params;
      const { quantity } = req.body;

      if (!quantity || quantity <= 0) {
        return res.status(400).json({ message: "Valid quantity is required" });
      }

      const inventory = await inventoryService.releaseReserved(
        productId,
        quantity
      );

      res.status(200).json({
        message: `Released ${quantity} reserved units`,
        inventory,
      });
    } catch (error) {
      logger.error(
        `[InventoryController] Error releasing stock: ${error.message}`
      );
      const status = error.message.includes("not found") ? 404 : 400;
      res.status(status).json({ message: error.message });
    }
  }

  /**
   * POST /api/inventory/:productId/confirm
   * Confirm order fulfillment
   */
  async confirmFulfillment(req, res, next) {
    try {
      const { productId } = req.params;
      const { quantity } = req.body;

      if (!quantity || quantity <= 0) {
        return res.status(400).json({ message: "Valid quantity is required" });
      }

      const inventory = await inventoryService.confirmFulfillment(
        productId,
        quantity
      );

      res.status(200).json({
        message: `Confirmed fulfillment of ${quantity} units`,
        inventory,
      });
    } catch (error) {
      logger.error(
        `[InventoryController] Error confirming fulfillment: ${error.message}`
      );
      const status = error.message.includes("not found") ? 404 : 400;
      res.status(status).json({ message: error.message });
    }
  }

  /**
   * POST /api/inventory/:productId/restock
   * Restock inventory
   */
  async restockInventory(req, res, next) {
    try {
      const { productId } = req.params;
      const { quantity } = req.body;

      if (!quantity || quantity <= 0) {
        return res.status(400).json({ message: "Valid quantity is required" });
      }

      const inventory = await inventoryService.restockInventory(
        productId,
        quantity
      );

      res.status(200).json({
        message: `Restocked ${quantity} units`,
        inventory,
      });
    } catch (error) {
      logger.error(`[InventoryController] Error restocking: ${error.message}`);
      const status = error.message.includes("not found") ? 404 : 500;
      res.status(status).json({ message: error.message });
    }
  }

  /**
   * PATCH /api/inventory/:productId
   * Adjust inventory manually
   */
  async adjustInventory(req, res, next) {
    try {
      const { productId } = req.params;
      const { availableDelta, reservedDelta } = req.body;

      if (availableDelta === undefined) {
        return res.status(400).json({ message: "availableDelta is required" });
      }

      const inventory = await inventoryService.adjustInventory(
        productId,
        availableDelta,
        reservedDelta || 0
      );

      res.status(200).json({
        message: "Inventory adjusted successfully",
        inventory,
      });
    } catch (error) {
      logger.error(
        `[InventoryController] Error adjusting inventory: ${error.message}`
      );
      const status = error.message.includes("not found") ? 404 : 400;
      res.status(status).json({ message: error.message });
    }
  }

  /**
   * GET /api/inventory/alerts/low-stock
   * Get low stock alerts
   */
  async getLowStockAlerts(req, res, next) {
    try {
      const threshold = parseInt(req.query.threshold) || 10;
      const items = await inventoryService.getLowStockAlerts(threshold);

      res.status(200).json({
        threshold,
        count: items.length,
        items,
      });
    } catch (error) {
      logger.error(
        `[InventoryController] Error getting low stock alerts: ${error.message}`
      );
      res.status(500).json({ message: error.message });
    }
  }

  /**
   * GET /api/inventory/alerts/out-of-stock
   * Get out of stock items
   */
  async getOutOfStock(req, res, next) {
    try {
      const items = await inventoryService.getOutOfStock();

      res.status(200).json({
        count: items.length,
        items,
      });
    } catch (error) {
      logger.error(
        `[InventoryController] Error getting out of stock: ${error.message}`
      );
      res.status(500).json({ message: error.message });
    }
  }

  /**
   * POST /api/inventory/check-availability
   * Check availability for multiple products
   */
  async checkAvailability(req, res, next) {
    try {
      const { productIds } = req.body;

      if (
        !productIds ||
        !Array.isArray(productIds) ||
        productIds.length === 0
      ) {
        return res
          .status(400)
          .json({ message: "productIds array is required" });
      }

      const availability = await inventoryService.checkAvailability(productIds);

      res.status(200).json(availability);
    } catch (error) {
      logger.error(
        `[InventoryController] Error checking availability: ${error.message}`
      );
      res.status(500).json({ message: error.message });
    }
  }

  /**
   * DELETE /api/inventory/:productId
   * Delete inventory record
   */
  async deleteInventory(req, res, next) {
    try {
      const { productId } = req.params;
      await inventoryService.deleteInventory(productId);

      res.status(204).send();
    } catch (error) {
      logger.error(
        `[InventoryController] Error deleting inventory: ${error.message}`
      );
      const status = error.message.includes("not found") ? 404 : 500;
      res.status(status).json({ message: error.message });
    }
  }
}

module.exports = new InventoryController();
