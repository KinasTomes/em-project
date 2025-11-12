const axios = require("axios");
const Order = require("../models/order");
const config = require("../config");
const logger = require("@ecommerce/logger");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");

class OrderService {
  constructor(messageBroker, outboxManager = null) {
    this.messageBroker = messageBroker;
    this.outboxManager = outboxManager;
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
   * @param {Array<number>} quantities - Array of quantities for each product
   * @param {string} username - Username from JWT token
   * @param {string} token - JWT token for authentication
   * @returns {Promise<Object>} Created order
   */
  async createOrder(productIds, quantities, username, token) {
    // 1. Validate products
    const products = await this.validateProducts(productIds, token);

    // 2. Calculate total price (price * quantity for each product)
    const totalPrice = products.reduce((acc, product, index) => {
      const price = Number(product?.price || 0);
      const quantity = quantities[index];
      return acc + (Number.isFinite(price) ? price : 0) * quantity;
    }, 0);

    // 3. Use MongoDB transaction to ensure atomicity
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 3a. Create order in DB
      const orderData = {
        products: products.map((p, index) => ({
          _id: p._id,
          name: p.name,
          price: p.price,
          description: p.description,
          quantity: quantities[index],
          reserved: false,
        })),
        user: username,
        totalPrice,
        status: "PENDING",
      };

      const [order] = await Order.create([orderData], { session });
      const orderId = order._id.toString();

      logger.info({ orderId, username }, "Order created successfully");

      // 3b. Create outbox events for RESERVE requests
      if (this.outboxManager) {
        // Use Outbox Pattern (Transactional Outbox)
        for (let i = 0; i < order.products.length; i++) {
          const prod = order.products[i];
          await this.outboxManager.createEvent({
            eventType: "RESERVE",
            payload: {
              orderId,
              productId: prod._id.toString(),
              quantity: prod.quantity,
            },
            session,
            correlationId: orderId, // Use orderId as correlationId
          });
        }

        logger.info(
          { orderId, username },
          "RESERVE events saved to outbox (transactional)"
        );
      } else {
        // Fallback: Direct publish using MessageBroker package
        logger.warn(
          "OutboxManager not available, falling back to direct publish"
        );
        for (const prod of order.products) {
          // Use Broker.publish() API (not publishMessage)
          await this.messageBroker.publish("inventory", {
            type: "RESERVE",
            data: {
              orderId,
              productId: prod._id.toString(),
              quantity: prod.quantity,
            },
            timestamp: new Date().toISOString(),
          }, {
            eventId: uuidv4(),
            correlationId: orderId
          });
        }
        logger.info(
          { orderId, username },
          "RESERVE events published directly (fallback)"
        );
      }

      // 4. Commit transaction
      await session.commitTransaction();
      logger.info({ orderId }, "Transaction committed successfully");

      return {
        orderId,
        message: "Order created and reservation requests published",
        products: order.products.map((p) => ({
          id: p._id,
          name: p.name,
          price: p.price,
          quantity: p.quantity,
        })),
        totalPrice,
        status: order.status,
      };
    } catch (error) {
      // Rollback transaction on error
      await session.abortTransaction();
      logger.error(
        { error: error.message, username },
        "Failed to create order, transaction rolled back"
      );
      throw error;
    } finally {
      session.endSession();
    }
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
