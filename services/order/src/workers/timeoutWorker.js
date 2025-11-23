const logger = require("@ecommerce/logger");

/**
 * Timeout Worker - Scans for expired outbox events and triggers compensations
 * 
 * Runs periodically to detect saga timeouts and publish compensation events.
 * Handles the "eventual timeout" pattern for distributed sagas.
 */
class TimeoutWorker {
  constructor(OutboxModel, broker, config = {}) {
    this.OutboxModel = OutboxModel;
    this.broker = broker;
    this.intervalMs = config.intervalMs || 30000; // 30 seconds default
    this.batchSize = config.batchSize || 100;
    this.isRunning = false;
    this.intervalId = null;
    this.serviceName = config.serviceName || "unknown";
  }

  /**
   * Start the timeout worker
   */
  start() {
    if (this.isRunning) {
      logger.warn({ serviceName: this.serviceName }, "TimeoutWorker already running");
      return;
    }

    this.isRunning = true;
    logger.info(
      {
        serviceName: this.serviceName,
        intervalMs: this.intervalMs,
        batchSize: this.batchSize,
      },
      "⏰ TimeoutWorker started"
    );

    // Run immediately on start
    this._scanExpiredEvents();

    // Schedule periodic scans
    this.intervalId = setInterval(() => {
      this._scanExpiredEvents();
    }, this.intervalMs);
  }

  /**
   * Stop the timeout worker
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
    logger.info({ serviceName: this.serviceName }, "⏹️  TimeoutWorker stopped");
  }

  /**
   * Scan for expired events and trigger compensations
   * @private
   */
  async _scanExpiredEvents() {
    const scanContext = {
      serviceName: this.serviceName,
      timestamp: new Date().toISOString(),
    };

    try {
      const now = new Date();

      // Find expired events (PENDING status + expiresAt < now)
      const expiredEvents = await this.OutboxModel.find({
        status: "PENDING",
        expiresAt: { $exists: true, $lt: now },
      })
        .sort({ expiresAt: 1 }) // Process oldest first
        .limit(this.batchSize)
        .lean();

      if (expiredEvents.length === 0) {
        logger.debug(scanContext, "No expired events found");
        return;
      }

      logger.info(
        { ...scanContext, count: expiredEvents.length },
        `🔍 Found ${expiredEvents.length} expired saga events`
      );

      // Process each expired event
      for (const event of expiredEvents) {
        await this._handleExpiredEvent(event);
      }

      logger.info(
        { ...scanContext, processed: expiredEvents.length },
        `✓ Processed ${expiredEvents.length} expired events`
      );
    } catch (error) {
      logger.error(
        {
          ...scanContext,
          error: error.message,
          stack: error.stack,
        },
        "❌ Error scanning expired events"
      );
    }
  }

  /**
   * Handle a single expired event
   * @private
   */
  async _handleExpiredEvent(event) {
    const eventContext = {
      eventId: event.eventId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      expiresAt: event.expiresAt,
      serviceName: this.serviceName,
    };

    try {
      logger.warn(
        eventContext,
        `⏱️  Saga timeout detected for ${event.eventType}`
      );

      // Mark event as TIMEOUT in outbox
      await this.OutboxModel.updateOne(
        { _id: event._id },
        {
          $set: {
            status: "FAILED",
            error: `Saga timeout - exceeded ${event.expiresAt.toISOString()}`,
            publishedAt: new Date(),
          },
        }
      );

      // Publish compensation event based on original event type
      const compensationEvent = this._buildCompensationEvent(event);

      if (compensationEvent) {
        await this.broker.publish(
          compensationEvent.eventType,
          compensationEvent.payload,
          {
            eventId: `${event.eventId}-timeout-comp`,
            correlationId: event.correlationId,
          }
        );

        logger.info(
          eventContext,
          `📤 Published compensation event: ${compensationEvent.eventType}`
        );
      } else {
        logger.warn(
          eventContext,
          `⚠️  No compensation handler defined for ${event.eventType}`
        );
      }
    } catch (error) {
      logger.error(
        {
          ...eventContext,
          error: error.message,
        },
        "❌ Failed to handle expired event"
      );

      // Update outbox with error (but don't throw - continue processing other events)
      try {
        await this.OutboxModel.updateOne(
          { _id: event._id },
          {
            $set: {
              error: `Compensation publish failed: ${error.message}`,
            },
          }
        );
      } catch (updateError) {
        logger.error(
          { eventId: event.eventId, error: updateError.message },
          "Failed to update outbox after error"
        );
      }
    }
  }

  /**
   * Build compensation event based on original event type
   * @private
   */
  _buildCompensationEvent(originalEvent) {
    const { eventType, payload, compensationData, correlationId } = originalEvent;

    // Map original events to their compensation events
    const compensationMap = {
      RESERVE: {
        eventType: "RELEASE",
        payload: {
          orderId: payload.orderId || compensationData?.orderId,
          productId: payload.productId || compensationData?.productId,
          quantity: payload.quantity || compensationData?.quantity,
          reason: "SAGA_TIMEOUT",
          originalEventId: originalEvent.eventId,
        },
      },
      ORDER_CREATED: {
        eventType: "ORDER_TIMEOUT",
        payload: {
          orderId: payload.orderId || compensationData?.orderId,
          reason: "SAGA_TIMEOUT",
          products: payload.products || compensationData?.products || [],
          originalEventId: originalEvent.eventId,
        },
      },
      PAYMENT_INITIATED: {
        eventType: "PAYMENT_CANCEL",
        payload: {
          orderId: payload.orderId || compensationData?.orderId,
          transactionId: payload.transactionId || compensationData?.transactionId,
          reason: "SAGA_TIMEOUT",
          originalEventId: originalEvent.eventId,
        },
      },
    };

    const compensation = compensationMap[eventType];

    if (!compensation) {
      return null;
    }

    return {
      eventType: compensation.eventType,
      payload: {
        ...compensation.payload,
        correlationId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Get worker statistics
   */
  async getStats() {
    const now = new Date();

    const [expired, pending] = await Promise.all([
      this.OutboxModel.countDocuments({
        status: "PENDING",
        expiresAt: { $exists: true, $lt: now },
      }),
      this.OutboxModel.countDocuments({
        status: "PENDING",
        expiresAt: { $exists: true, $gte: now },
      }),
    ]);

    return {
      isRunning: this.isRunning,
      serviceName: this.serviceName,
      intervalMs: this.intervalMs,
      expiredCount: expired,
      pendingWithTimeoutCount: pending,
    };
  }
}

module.exports = TimeoutWorker;
