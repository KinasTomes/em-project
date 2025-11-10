const express = require("express");
const router = express.Router();
const inventoryController = require("../controllers/inventoryController");
const { isAuthenticated } = require("../middlewares/authMiddleware");

// All routes require authentication
router.use(isAuthenticated);

// Get all inventory with pagination
router.get("/", inventoryController.getAllInventory.bind(inventoryController));

// Alert routes
router.get(
  "/alerts/low-stock",
  inventoryController.getLowStockAlerts.bind(inventoryController)
);
router.get(
  "/alerts/out-of-stock",
  inventoryController.getOutOfStock.bind(inventoryController)
);

// Check availability for multiple products
router.post(
  "/check-availability",
  inventoryController.checkAvailability.bind(inventoryController)
);

// Get inventory for specific product
router.get(
  "/:productId",
  inventoryController.getInventoryByProductId.bind(inventoryController)
);

// Create new inventory
router.post("/", inventoryController.createInventory.bind(inventoryController));

// Reserve stock for order
router.post(
  "/:productId/reserve",
  inventoryController.reserveStock.bind(inventoryController)
);

// Release reserved stock
router.post(
  "/:productId/release",
  inventoryController.releaseReserved.bind(inventoryController)
);

// Confirm fulfillment
router.post(
  "/:productId/confirm",
  inventoryController.confirmFulfillment.bind(inventoryController)
);

// Restock inventory
router.post(
  "/:productId/restock",
  inventoryController.restockInventory.bind(inventoryController)
);

// Adjust inventory manually
router.patch(
  "/:productId",
  inventoryController.adjustInventory.bind(inventoryController)
);

// Delete inventory
router.delete(
  "/:productId",
  inventoryController.deleteInventory.bind(inventoryController)
);

module.exports = router;
