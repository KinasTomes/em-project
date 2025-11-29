const express = require("express");
const isAuthenticated = require("../middlewares/isAuthenticated");

const router = express.Router();

module.exports = (orderController) => {
  // Get orders for current user (must be before /:id to avoid conflict)
  router.get("/", isAuthenticated, orderController.getMyOrders);
  // Create order endpoint
  router.post("/", isAuthenticated, orderController.createOrder);
  // Get order by id (status/details)
  router.get("/:id", isAuthenticated, orderController.getOrderById);

  return router;
};
