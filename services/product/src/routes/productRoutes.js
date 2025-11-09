const express = require("express");
const ProductController = require("../controllers/productController");
const isAuthenticated = require("../utils/isAuthenticated");

const router = express.Router();
const productController = new ProductController();

// Product CRUD endpoints (RESTful)
router.get("/", isAuthenticated, productController.getProducts);
router.get("/:id", isAuthenticated, productController.getProductById);
router.post("/", isAuthenticated, productController.createProduct);
router.put("/:id", isAuthenticated, productController.updateProduct);
router.delete("/:id", isAuthenticated, productController.deleteProduct);

module.exports = router;
