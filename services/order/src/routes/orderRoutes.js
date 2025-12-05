const express = require("express");

const router = express.Router();

// All routes accessible - API Gateway handles authentication
// Order service reads X-User-ID from header when needed
module.exports = (orderController) => {
  // Get orders for current user (must be before /:id to avoid conflict)
  router.get("/", orderController.getMyOrders);
  // Create order endpoint
  router.post("/", orderController.createOrder);
  // Get order by id (status/details)
  router.get("/:id", orderController.getOrderById);

  return router;
};
