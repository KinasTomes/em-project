const logger = require("@ecommerce/logger");

/**
 * Base class for compensation handlers with built-in retry, backoff, and DLQ support
 * 
 * Usage:
 * class ReleaseInventoryHandler extends CompensationHandler {
 *   async compensate(context) {
 *     await inventoryService.release(context.productId, context.quantity);
 *   }
 * }
 */
class CompensationHandler {
  constructor(config = {}) {
    this.name = config.name || this.constructor.name;
    this.maxRetries = config.maxRetries || 3;
    this.initialRetryDelay = config.initialRetryDelay || 1000;
    this.maxRetryDelay = config.maxRetryDelay || 30000;
    this.backoffMultiplier = config.backoffMultiplier || 2;
    this.dlqPublisher = config.dlqPublisher; // Optional: for failed compensations
    this.timeoutMs = config.timeoutMs || 30000; // 30s default timeout per attempt
  }

  /**
   * Execute compensation with retry logic
   * @param {Object} context - Compensation context (orderId, productId, quantity, etc.)
   * @param {Object} metadata - Message metadata (messageId, correlationId, etc.)
   * @returns {Promise<Object>} Result object { success, attempts, error }
   */
  async execute(context, metadata = {}) {
    const logContext = {
      handler: this.name,
      correlationId: metadata.correlationId || context.orderId,
      messageId: metadata.messageId,
      ...context,
    };

    logger.info(logContext, `[${this.name}] Starting compensation execution`);

    let lastError;
    let attempt = 0;

    while (attempt < this.maxRetries) {
      attempt++;
      const attemptLogContext = { ...logContext, attempt, maxRetries: this.maxRetries };

      try {
        logger.info(attemptLogContext, `[${this.name}] Attempt ${attempt}/${this.maxRetries}`);

        // Execute with timeout
        const result = await this._executeWithTimeout(context, metadata);

        logger.info(
          attemptLogContext,
          `[${this.name}] ✓ Compensation succeeded on attempt ${attempt}`
        );

        return {
          success: true,
          attempts: attempt,
          result,
        };
      } catch (error) {
        lastError = error;
        logger.warn(
          {
            ...attemptLogContext,
            error: error.message,
            stack: error.stack,
          },
          `[${this.name}] ✗ Attempt ${attempt} failed`
        );

        // Check if error is retryable
        const isRetryable = this._isRetryableError(error);
        if (!isRetryable) {
          logger.error(
            attemptLogContext,
            `[${this.name}] Non-retryable error, stopping retries`
          );
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < this.maxRetries) {
          const delay = this._calculateBackoffDelay(attempt);
          logger.info(
            attemptLogContext,
            `[${this.name}] Waiting ${delay}ms before retry...`
          );
          await this._sleep(delay);
        }
      }
    }

    // All retries exhausted
    logger.error(
      {
        ...logContext,
        attempts: attempt,
        error: lastError?.message,
      },
      `[${this.name}] ❌ Compensation failed after ${attempt} attempts`
    );

    // Send to DLQ if configured
    await this._handleFailure(context, metadata, lastError, attempt);

    return {
      success: false,
      attempts: attempt,
      error: lastError?.message || "Unknown error",
    };
  }

  /**
   * Execute compensation with timeout protection
   * @private
   */
  async _executeWithTimeout(context, metadata) {
    return Promise.race([
      this.compensate(context, metadata),
      this._timeout(this.timeoutMs),
    ]);
  }

  /**
   * Abstract method - must be implemented by subclasses
   * @param {Object} context - Compensation context
   * @param {Object} metadata - Message metadata
   * @returns {Promise<any>} Compensation result
   */
  async compensate(context, metadata) {
    throw new Error(`${this.name}.compensate() must be implemented by subclass`);
  }

  /**
   * Determine if error is retryable (can be overridden)
   * @param {Error} error
   * @returns {boolean}
   */
  _isRetryableError(error) {
    const nonRetryablePatterns = [
      /not found/i,
      /does not exist/i,
      /invalid.*id/i,
      /validation error/i,
      /duplicate/i,
    ];

    const message = error.message || "";
    const isNonRetryable = nonRetryablePatterns.some((pattern) => pattern.test(message));

    // Network/timeout errors are retryable
    const isTransient =
      error.code === "ECONNREFUSED" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ENOTFOUND" ||
      error.name === "TimeoutError" ||
      message.includes("timeout");

    return isTransient || !isNonRetryable;
  }

  /**
   * Calculate exponential backoff delay
   * @private
   */
  _calculateBackoffDelay(attempt) {
    const delay = this.initialRetryDelay * Math.pow(this.backoffMultiplier, attempt - 1);
    return Math.min(delay, this.maxRetryDelay);
  }

  /**
   * Handle final failure - send to DLQ, alert, etc.
   * @private
   */
  async _handleFailure(context, metadata, error, attempts) {
    if (!this.dlqPublisher) {
      logger.warn(
        { handler: this.name },
        "No DLQ publisher configured, compensation failure not persisted"
      );
      return;
    }

    try {
      await this.dlqPublisher.publish("COMPENSATION_FAILED", {
        handler: this.name,
        context,
        metadata,
        error: {
          message: error?.message,
          stack: error?.stack,
          code: error?.code,
        },
        attempts,
        failedAt: new Date().toISOString(),
      });

      logger.info(
        { handler: this.name, correlationId: metadata.correlationId },
        "Compensation failure published to DLQ"
      );
    } catch (dlqError) {
      logger.error(
        {
          handler: this.name,
          error: dlqError.message,
        },
        "Failed to publish to DLQ"
      );
    }
  }

  /**
   * Sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Timeout promise
   * @private
   */
  _timeout(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(`Compensation timeout after ${ms}ms`);
        error.name = "TimeoutError";
        reject(error);
      }, ms);
    });
  }
}

module.exports = CompensationHandler;
