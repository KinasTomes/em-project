const express = require("express");
const ProductController = require("../controllers/productController");

const router = express.Router();
const productController = new ProductController();

// All routes accessible - API Gateway handles authentication
// Product CRUD endpoints (RESTful)
router.get("/", productController.getProducts);
router.get("/:id", productController.getProductById);
router.post("/", productController.createProduct);
router.put("/:id", productController.updateProduct);
router.delete("/:id", productController.deleteProduct);

module.exports = router;
