const logger = require("@ecommerce/logger");
const mongoose = require("mongoose");

/**
 * Saga Orchestrator for Order Flow
 * 
 * Orchestrates multi-step order saga with automatic compensation on failures.
 * Steps: RESERVE_INVENTORY → PROCESS_PAYMENT → CONFIRM_ORDER
 */
class OrderSagaOrchestrator {
  constructor(outboxManager, broker, config = {}) {
    this.outboxManager = outboxManager;
    this.broker = broker;
    this.defaultTimeoutMs = config.defaultTimeoutMs || 60000; // 60s default
  }

  /**
   * Execute order saga with compensation on failure
   * @param {Object} order - Order document
   * @param {Array} products - Product details
   * @returns {Promise<Object>} Saga execution result
   */
  async executeOrderSaga(order, products) {
    const sagaContext = {
      orderId: order._id.toString(),
      correlationId: order._id.toString(),
      products: products.map((p, idx) => ({
        productId: p._id.toString(),
        name: p.name,
        price: p.price,
        quantity: order.products[idx].quantity,
      })),
      completedSteps: [],
      currentStep: null,
      status: "PENDING",
    };

    logger.info(
      {
        orderId: sagaContext.orderId,
        productCount: sagaContext.products.length,
      },
      "[OrderSaga] Starting order saga"
    );

    try {
      // Step 1: Reserve Inventory
      await this._executeStep(sagaContext, {
        name: "RESERVE_INVENTORY",
        execute: () => this._reserveInventory(sagaContext, order),
        compensate: () => this._releaseInventory(sagaContext),
      });

      // Step 2: Process Payment (placeholder - would call payment service)
      // await this._executeStep(sagaContext, {
      //   name: "PROCESS_PAYMENT",
      //   execute: () => this._processPayment(sagaContext, order),
      //   compensate: () => this._refundPayment(sagaContext),
      // });

      // Step 3: Confirm Order
      await this._executeStep(sagaContext, {
        name: "CONFIRM_ORDER",
        execute: () => this._confirmOrder(sagaContext, order),
        compensate: () => this._cancelOrder(sagaContext, order),
      });

      logger.info(
        { orderId: sagaContext.orderId },
        "[OrderSaga] ✓ Saga completed successfully"
      );

      return {
        success: true,
        orderId: sagaContext.orderId,
        completedSteps: sagaContext.completedSteps,
      };
    } catch (error) {
      logger.error(
        {
          orderId: sagaContext.orderId,
          error: error.message,
          currentStep: sagaContext.currentStep,
          completedSteps: sagaContext.completedSteps,
        },
        "[OrderSaga] ❌ Saga failed, triggering compensations"
      );

      // Compensate in reverse order
      await this._compensateCompletedSteps(sagaContext);

      throw error;
    }
  }

  /**
   * Execute a single saga step
   * @private
   */
  async _executeStep(sagaContext, step) {
    sagaContext.currentStep = step.name;

    logger.info(
      {
        orderId: sagaContext.orderId,
        step: step.name,
      },
      `[OrderSaga] Executing step: ${step.name}`
    );

    try {
      await step.execute();

      sagaContext.completedSteps.push({
        name: step.name,
        compensate: step.compensate,
        completedAt: new Date(),
      });

      logger.info(
        {
          orderId: sagaContext.orderId,
          step: step.name,
        },
        `[OrderSaga] ✓ Step completed: ${step.name}`
      );
    } catch (error) {
      logger.error(
        {
          orderId: sagaContext.orderId,
          step: step.name,
          error: error.message,
        },
        `[OrderSaga] ✗ Step failed: ${step.name}`
      );
      throw error;
    }
  }

  /**
   * Compensate all completed steps in reverse order
   * @private
   */
  async _compensateCompletedSteps(sagaContext) {
    logger.warn(
      {
        orderId: sagaContext.orderId,
        stepCount: sagaContext.completedSteps.length,
      },
      "[OrderSaga] Starting compensation rollback"
    );

    // Reverse order compensation
    const stepsToCompensate = [...sagaContext.completedSteps].reverse();

    for (const step of stepsToCompensate) {
      try {
        logger.info(
          {
            orderId: sagaContext.orderId,
            step: step.name,
          },
          `[OrderSaga] Compensating step: ${step.name}`
        );

        await step.compensate();

        logger.info(
          {
            orderId: sagaContext.orderId,
            step: step.name,
          },
          `[OrderSaga] ✓ Compensation successful: ${step.name}`
        );
      } catch (compensationError) {
        // Log but continue - best effort compensation
        logger.error(
          {
            orderId: sagaContext.orderId,
            step: step.name,
            error: compensationError.message,
          },
          `[OrderSaga] ✗ Compensation failed: ${step.name}`
        );

        // Publish to DLQ for manual intervention
        try {
          await this.broker.publish("COMPENSATION_FAILED", {
            orderId: sagaContext.orderId,
            step: step.name,
            error: compensationError.message,
            timestamp: new Date().toISOString(),
          });
        } catch (dlqError) {
          logger.error(
            {
              orderId: sagaContext.orderId,
              error: dlqError.message,
            },
            "[OrderSaga] Failed to publish compensation failure to DLQ"
          );
        }
      }
    }
  }

  /**
   * Step 1: Reserve Inventory
   * @private
   */
  async _reserveInventory(sagaContext, order) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      for (const product of sagaContext.products) {
        const expiresAt = new Date(Date.now() + this.defaultTimeoutMs);

        await this.outboxManager.createEvent({
          eventType: "RESERVE",
          payload: {
            orderId: sagaContext.orderId,
            productId: product.productId,
            quantity: product.quantity,
          },
          session,
          correlationId: sagaContext.correlationId,
          expiresAt, // Saga timeout
          compensationData: {
            orderId: sagaContext.orderId,
            productId: product.productId,
            quantity: product.quantity,
            products: sagaContext.products,
          },
        });
      }

      await session.commitTransaction();

      logger.info(
        {
          orderId: sagaContext.orderId,
          productCount: sagaContext.products.length,
        },
        "[OrderSaga] RESERVE events created in outbox"
      );
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Compensation for Step 1: Release Inventory
   * @private
   */
  async _releaseInventory(sagaContext) {
    logger.info(
      { orderId: sagaContext.orderId },
      "[OrderSaga] Compensating: Releasing inventory"
    );

    for (const product of sagaContext.products) {
      try {
        await this.broker.publish(
          "RELEASE",
          {
            orderId: sagaContext.orderId,
            productId: product.productId,
            quantity: product.quantity,
            reason: "SAGA_COMPENSATION",
          },
          {
            eventId: `${sagaContext.orderId}-release-${product.productId}`,
            correlationId: sagaContext.correlationId,
          }
        );
      } catch (error) {
        logger.error(
          {
            orderId: sagaContext.orderId,
            productId: product.productId,
            error: error.message,
          },
          "[OrderSaga] Failed to publish RELEASE compensation"
        );
        throw error;
      }
    }
  }

  /**
   * Step 3: Confirm Order
   * @private
   */
  async _confirmOrder(sagaContext, order) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await this.outboxManager.createEvent({
        eventType: "ORDER_CONFIRMED",
        payload: {
          orderId: sagaContext.orderId,
          timestamp: new Date().toISOString(),
        },
        session,
        correlationId: sagaContext.correlationId,
      });

      await session.commitTransaction();

      logger.info(
        { orderId: sagaContext.orderId },
        "[OrderSaga] ORDER_CONFIRMED event created"
      );
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Compensation for Step 3: Cancel Order
   * @private
   */
  async _cancelOrder(sagaContext, order) {
    logger.info(
      { orderId: sagaContext.orderId },
      "[OrderSaga] Compensating: Canceling order"
    );

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await this.outboxManager.createEvent({
        eventType: "ORDER_CANCELLED",
        payload: {
          orderId: sagaContext.orderId,
          reason: "SAGA_COMPENSATION",
          timestamp: new Date().toISOString(),
        },
        session,
        correlationId: sagaContext.correlationId,
      });

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }
}

module.exports = OrderSagaOrchestrator;
