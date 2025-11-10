const axios = require("axios");
const Order = require("../models/order");
const config = require("../config");
const logger = require("@ecommerce/logger");
const { v4: uuidv4 } = require("uuid");

class OrderService {
  constructor(messageBroker) {
    this.messageBroker = messageBroker;
    this.productServiceUrl =
      process.env.PRODUCT_SERVICE_URL || "http://product:3004";
  }

  /**
   * Validate products by calling Product Service
   * @param {Array<string>} productIds - Array of product IDs
   * @param {string} token - JWT token for authentication
   * @returns {Promise<Array>} Array of validated products
   */
  async validateProducts(productIds, token) {
    try {
      // Fetch all products and filter by IDs
      // In a production system, Product Service should have a batch GET endpoint
      const authHeader =
        token && token.startsWith("Bearer ") ? token : `Bearer ${token}`;
      const response = await axios.get(
        `${this.productServiceUrl}/api/products`,
        {
          headers: {
            Authorization: authHeader,
          },
          timeout: 5000,
        }
      );

      if (response.status !== 200) {
        throw new Error(`Product Service returned status ${response.status}`);
      }

      const allProducts = response.data;
      const validProducts = allProducts.filter((p) =>
        productIds.includes(p._id.toString())
      );

      if (validProducts.length !== productIds.length) {
        const foundIds = validProducts.map((p) => p._id.toString());
        const missingIds = productIds.filter((id) => !foundIds.includes(id));
        throw new Error(`Products not found: ${missingIds.join(", ")}`);
      }

      return validProducts;
    } catch (error) {
      logger.error(
        { error: error.message, productIds },
        "Failed to validate products"
      );
      throw error;
    }
  }

  /**
   * Create a new order
   * @param {Array<string>} productIds - Array of product IDs
   * @param {string} username - Username from JWT token
   * @param {string} token - JWT token for authentication
   * @returns {Promise<Object>} Created order
   */
  async createOrder(productIds, username, token) {
    // 1. Validate products
    const products = await this.validateProducts(productIds, token);

    // 2. Calculate total price
    const totalPrice = products.reduce((acc, product) => {
      const price = Number(product?.price || 0);
      return acc + (Number.isFinite(price) ? price : 0);
    }, 0);

    // 3. Create order in DB
    const order = new Order({
      products: products.map((p) => ({
        _id: p._id,
        name: p.name,
        price: p.price,
        description: p.description,
        reserved: false,
      })),
      user: username,
      totalPrice,
      status: "PENDING",
    });

    await order.save();
    logger.info({ orderId: order._id, username }, "Order created successfully");

    // 4. Publish RESERVE requests to Inventory service (choreography)
    const orderId = order._id.toString();
    for (const prod of order.products) {
      await this.messageBroker.publishMessage("inventory", {
        type: "RESERVE",
        data: {
          orderId,
          productId: prod._id.toString(),
          quantity: 1,
        },
        timestamp: new Date().toISOString(),
      });
    }

    logger.info(
      { orderId, username },
      "RESERVE requests published to inventory queue"
    );

    return {
      orderId,
      message: "Order created and reservation requests published",
      products: order.products.map((p) => ({
        id: p._id,
        name: p.name,
        price: p.price,
      })),
      totalPrice,
      status: order.status,
    };
  }

  /**
   * Get order by id
   */
  async getOrderById(orderId) {
    try {
      const order = await Order.findById(orderId);
      return order;
    } catch (error) {
      logger.error(
        { error: error.message, orderId },
        "Failed to get order by id"
      );
      throw error;
    }
  }
}

module.exports = OrderService;
