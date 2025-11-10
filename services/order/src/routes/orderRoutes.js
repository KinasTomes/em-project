const express = require("express");
const isAuthenticated = require("../middlewares/isAuthenticated");

const router = express.Router();

module.exports = (orderController) => {
  // Create order endpoint
  router.post("/", isAuthenticated, orderController.createOrder);
  // Get order by id (status/details)
  router.get("/:id", isAuthenticated, orderController.getOrderById);

  return router;
};
