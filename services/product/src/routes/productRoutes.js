const express = require("express");
const ProductController = require("../controllers/productController");
const isAuthenticated = require("../utils/isAuthenticated");

const router = express.Router();
const productController = new ProductController();

// Product CRUD endpoints (RESTful)
router.get("/products", isAuthenticated, productController.getProducts);
router.get("/products/:id", isAuthenticated, productController.getProductById);
router.post("/products", isAuthenticated, productController.createProduct);
router.put("/products/:id", isAuthenticated, productController.updateProduct);
router.delete(
  "/products/:id",
  isAuthenticated,
  productController.deleteProduct
);

// Order endpoint - publishes to RabbitMQ queue for order service to consume
router.post("/orders", isAuthenticated, productController.createOrder);

module.exports = router;
