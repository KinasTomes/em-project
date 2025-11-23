const { CompensationHandler } = require("@ecommerce/compensation-pattern");
const inventoryService = require("../services/inventoryService");
const logger = require("@ecommerce/logger");

/**
 * Handle ORDER_TIMEOUT events - release all reservations for the order
 */
class OrderTimeoutHandler extends CompensationHandler {
  constructor(config = {}) {
    super({
      name: "OrderTimeoutHandler",
      maxRetries: 3,
      initialRetryDelay: 1000,
      timeoutMs: 30000,
      ...config,
    });
  }

  async compensate(context, metadata) {
    const { orderId, products = [], reason } = context;

    logger.info(
      {
        orderId,
        productCount: products.length,
        reason,
        correlationId: metadata.correlationId,
      },
      "[OrderTimeoutHandler] Releasing reservations for timed-out order"
    );

    if (!products || products.length === 0) {
      logger.warn(
        { orderId },
        "[OrderTimeoutHandler] No products to release"
      );
      return { releasedCount: 0 };
    }

    const results = [];

    for (const product of products) {
      const { productId, quantity } = product;

      if (!productId || !quantity) {
        logger.warn(
          { orderId, product },
          "[OrderTimeoutHandler] Invalid product data, skipping"
        );
        continue;
      }

      try {
        await inventoryService.releaseReserved(productId, quantity);
        results.push({ productId, quantity, success: true });

        logger.info(
          { orderId, productId, quantity },
          "[OrderTimeoutHandler] ✓ Released reservation"
        );
      } catch (error) {
        // Check if already released (idempotency)
        if (error.message?.includes("Cannot release")) {
          logger.warn(
            { orderId, productId, quantity },
            "[OrderTimeoutHandler] Already released or insufficient reserved stock"
          );
          results.push({ productId, quantity, success: true, alreadyReleased: true });
        } else {
          logger.error(
            {
              orderId,
              productId,
              quantity,
              error: error.message,
            },
            "[OrderTimeoutHandler] ✗ Failed to release reservation"
          );
          throw error; // Propagate to trigger retry
        }
      }
    }

    return {
      orderId,
      releasedCount: results.filter((r) => r.success).length,
      results,
    };
  }
}

/**
 * Handle RESERVE_FAILED events - already a failure, just log
 */
class ReserveFailedHandler extends CompensationHandler {
  constructor(config = {}) {
    super({
      name: "ReserveFailedHandler",
      maxRetries: 1, // No need for retries, just tracking
      timeoutMs: 10000,
      ...config,
    });
  }

  async compensate(context, metadata) {
    const { orderId, productId, quantity, reason } = context;

    logger.warn(
      {
        orderId,
        productId,
        quantity,
        reason,
        correlationId: metadata.correlationId,
      },
      "[ReserveFailedHandler] Reservation failed (no compensation needed)"
    );

    // No actual compensation needed - reservation never succeeded
    // This handler mainly exists for tracking/auditing
    return {
      orderId,
      productId,
      action: "tracked",
      reason,
    };
  }
}

/**
 * Handle RELEASE events - standard release compensation
 */
class ReleaseInventoryHandler extends CompensationHandler {
  constructor(config = {}) {
    super({
      name: "ReleaseInventoryHandler",
      maxRetries: 3,
      initialRetryDelay: 1000,
      timeoutMs: 30000,
      ...config,
    });
  }

  async compensate(context, metadata) {
    const { orderId, productId, quantity, reason } = context;

    logger.info(
      {
        orderId,
        productId,
        quantity,
        reason,
        correlationId: metadata.correlationId,
      },
      "[ReleaseInventoryHandler] Releasing inventory reservation"
    );

    try {
      await inventoryService.releaseReserved(productId, quantity);

      logger.info(
        { orderId, productId, quantity },
        "[ReleaseInventoryHandler] ✓ Released successfully"
      );

      return { orderId, productId, quantity, released: true };
    } catch (error) {
      // Handle idempotency - already released
      if (error.message?.includes("Cannot release")) {
        logger.warn(
          { orderId, productId, quantity },
          "[ReleaseInventoryHandler] Already released (idempotent)"
        );
        return { orderId, productId, quantity, released: true, alreadyReleased: true };
      }

      throw error;
    }
  }
}

module.exports = {
  OrderTimeoutHandler,
  ReserveFailedHandler,
  ReleaseInventoryHandler,
};
