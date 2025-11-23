const amqp = require("amqplib");
const config = require("../config");
const logger = require("@ecommerce/logger");
const inventoryService = require("../services/inventoryService");
const processedMessageRepository = require("../repositories/processedMessageRepository");

class MessageBroker {
  constructor() {
    this.channel = null;
    this.connection = null;
  }

  async connect() {
    await this.connectWithRetry();
  }

  async connectWithRetry(retries = 5, delay = 5000) {
    for (let i = 1; i <= retries; i++) {
      try {
        logger.info(
          `⏳ [Inventory] Connecting to RabbitMQ... (Attempt ${i}/${retries})`
        );
        this.connection = await amqp.connect(config.rabbitMQURI);
        this.channel = await this.connection.createChannel();

        // Declare queues aligned with central broker (DLX settings)
        // Orders queue (responses go here)
        await this.channel.assertQueue("orders", {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': `orders.dlq`
          }
        });
        await this.channel.assertQueue(`orders.dlq`, { durable: true });

        // RESERVE requests from Order service (eventType as queue name)
        await this.channel.assertQueue("RESERVE", {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': `RESERVE.dlq`
          }
        });
        await this.channel.assertQueue(`RESERVE.dlq`, { durable: true });

        // PAYMENT_FAILED compensation events
        await this.channel.assertQueue("PAYMENT_FAILED", {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': `PAYMENT_FAILED.dlq`
          }
        });
        await this.channel.assertQueue(`PAYMENT_FAILED.dlq`, { durable: true });

        // ORDER_TIMEOUT compensation events
        await this.channel.assertQueue("ORDER_TIMEOUT", {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': `ORDER_TIMEOUT.dlq`
          }
        });
        await this.channel.assertQueue(`ORDER_TIMEOUT.dlq`, { durable: true });

        // RELEASE compensation events
        await this.channel.assertQueue("RELEASE", {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': `RELEASE.dlq`
          }
        });
        await this.channel.assertQueue(`RELEASE.dlq`, { durable: true });

        logger.info("✓ [Inventory] RabbitMQ connected");

        // Start consuming messages
        this.startConsuming();

        // Handle connection errors
        this.connection.on("error", (err) => {
          logger.error(`[Inventory] RabbitMQ connection error: ${err.message}`);
        });

        this.connection.on("close", async () => {
          logger.warn(
            "[Inventory] RabbitMQ connection closed. Auto-reconnecting..."
          );
          this.connection = null;
          this.channel = null;
          
          await new Promise(res => setTimeout(res, 5000));
          
          try {
            await this.connectWithRetry();
            logger.info("✓ [Inventory] RabbitMQ reconnected and consumer restored");
          } catch (error) {
            logger.error(`❌ [Inventory] Failed to reconnect: ${error.message}`);
          }
        });

        return;
      } catch (err) {
        logger.error(
          `✗ [Inventory] Failed to connect to RabbitMQ: ${err.message}`
        );
        if (i < retries) {
          logger.info(`Retrying in ${delay / 1000} seconds...`);
          await new Promise((res) => setTimeout(res, delay));
        } else {
          logger.error(
            "✗ [Inventory] Could not connect to RabbitMQ after all retries."
          );
        }
      }
    }
  }

  /**
   * Start consuming messages from queues
   */
  startConsuming() {
    const {
      OrderTimeoutHandler,
      ReleaseInventoryHandler,
    } = require("../handlers/compensationHandlers");

    // Consume RESERVE requests published with eventType as queue name
    this.consumeMessage(
      "RESERVE",
      async (payload, meta) => {
        await this.handleReserveRequest(payload, meta);
      },
      { idempotent: true }
    );

    this.consumeMessage(
      "PAYMENT_FAILED",
      async (payload, meta) => {
        await this.handlePaymentFailedEvent(payload, meta);
      },
      { idempotent: true, messageIdExtractor: (body) => body?.eventId || body?.id }
    );

    // ORDER_TIMEOUT compensation
    this.consumeMessage(
      "ORDER_TIMEOUT",
      async (payload, meta) => {
        const handler = new OrderTimeoutHandler();
        await handler.execute(payload, meta);
      },
      { idempotent: true }
    );

    // RELEASE compensation
    this.consumeMessage(
      "RELEASE",
      async (payload, meta) => {
        const handler = new ReleaseInventoryHandler();
        await handler.execute(payload, meta);
      },
      { idempotent: true }
    );
  }

  /**
   * Handle product events based on message type
   */
  async handleProductEvents(message) {
    try {
      const { type, data } = message;

      switch (type) {
        case "PRODUCT_CREATED":
          await this.handleProductCreated(data);
          break;
        case "PRODUCT_DELETED":
          await this.handleProductDeleted(data);
          break;
        default:
          logger.warn(`[Inventory] Unknown product event type: ${type}`);
      }
    } catch (error) {
      logger.error(
        `[Inventory] Error handling product event: ${error.message}`
      );
    }
  }

  /**
   * Handle inventory events based on message type
   */
  async handleInventoryEvents(message) {
    try {
      const { type, data } = message;

      switch (type) {
        case "RESERVE":
          await this.handleReserveRequest(data);
          break;
        case "RELEASE":
          await this.handleReleaseRequest(data);
          break;
        case "RESTOCK":
          await this.handleRestockRequest(data);
          break;
        default:
          logger.warn(`[Inventory] Unknown inventory event type: ${type}`);
      }
    } catch (error) {
      logger.error(
        `[Inventory] Error handling inventory event: ${error.message}`
      );
    }
  }

  /**
   * Handle product created event - Initialize inventory
   */
  async handleProductCreated(data) {
    try {
      const { productId } = data;
      // Prefer 'available' (new contract), fallback to legacy 'initialStock'
      const availableRaw =
        typeof data.available !== "undefined"
          ? data.available
          : typeof data.initialStock !== "undefined"
          ? data.initialStock
          : undefined;

      const availableParsed = Number(availableRaw);
      const availableNormalized =
        Number.isFinite(availableParsed) && availableParsed >= 0
          ? Math.floor(availableParsed)
          : 0;

      if (
        availableRaw !== undefined &&
        Number(availableRaw) !== availableNormalized
      ) {
        logger.warn(
          `[Inventory] Normalized available value '${availableRaw}' for product ${productId} -> ${availableNormalized}`
        );
      }

      logger.info(
        `[Inventory] Handling PRODUCT_CREATED event for ${productId} with available ${availableNormalized}`
      );

      await inventoryService.createInventory(productId, availableNormalized);
      logger.info(
        `[Inventory] Initialized inventory for product ${productId} with available ${availableNormalized}`
      );
    } catch (error) {
      logger.error(
        `[Inventory] Error handling PRODUCT_CREATED: ${error.message}`
      );
      // Don't throw - just log error and continue
    }
  }

  /**
   * Handle product deleted event - Clean up inventory
   */
  async handleProductDeleted(data) {
    try {
      const { productId } = data;
      logger.info(
        `[Inventory] Handling PRODUCT_DELETED event for ${productId}`
      );

      await inventoryService.deleteInventory(productId);
      logger.info(`[Inventory] Deleted inventory for product ${productId}`);
    } catch (error) {
      logger.error(
        `[Inventory] Error handling PRODUCT_DELETED: ${error.message}`
      );
    }
  }

  /**
   * Handle inventory reserve request
   */
  async handleReserveRequest(data) {
    try {
      const { productId, quantity, orderId } = data;
      logger.info(`[Inventory] Handling RESERVE request for order ${orderId}`);

      const result = await inventoryService.reserveStock(productId, quantity);

      // Publish response back to order service (orders queue with response type)
      if (result.success) {
        await this.publishMessage("orders", {
          type: "INVENTORY_RESERVED",
          data: {
            orderId,
            productId,
            quantity,
            success: true,
          },
          timestamp: new Date().toISOString(),
        });
      } else {
        await this.publishMessage("orders", {
          type: "INVENTORY_RESERVE_FAILED",
          data: {
            orderId,
            productId,
            quantity,
            reason: result.message,
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error(
        `[Inventory] Error handling RESERVE request: ${error.message}`
      );
    }
  }

  /**
   * Handle inventory release request
   */
  async handleReleaseRequest(data) {
    try {
      const { productId, quantity, orderId } = data;
      logger.info(`[Inventory] Handling RELEASE request for order ${orderId}`);

      await inventoryService.releaseReserved(productId, quantity);
      logger.info(
        `[Inventory] Released ${quantity} units for product ${productId}`
      );
    } catch (error) {
      logger.error(
        `[Inventory] Error handling RELEASE request: ${error.message}`
      );
    }
  }

  /**
   * Handle inventory restock request
   */
  async handleRestockRequest(data) {
    try {
      const { productId, quantity } = data;
      logger.info(
        `[Inventory] Handling RESTOCK request for product ${productId}`
      );

      await inventoryService.restockInventory(productId, quantity);
      logger.info(
        `[Inventory] Restocked ${quantity} units for product ${productId}`
      );
    } catch (error) {
      logger.error(
        `[Inventory] Error handling RESTOCK request: ${error.message}`
      );
    }
  }

  /**
   * Handle payment failed events to release inventory reservations
   */
  async handlePaymentFailedEvent(data, meta = {}) {
    const messageId = meta?.messageId;
    const orderId = data?.orderId;
    const reason = data?.reason || "PAYMENT_FAILED";

    logger.warn(
      {
        orderId,
        messageId,
        reason,
      },
      `[Inventory] Handling PAYMENT_FAILED compensation`
    );

    const rawItems = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.products)
      ? data.products
      : [];

    const normalizedItems = rawItems.length
      ? rawItems
      : data?.productId && data?.quantity
      ? [{ productId: data.productId, quantity: data.quantity }]
      : [];

    if (!normalizedItems.length) {
      logger.warn(
        {
          orderId,
          payload: data,
          messageId,
        },
        `[Inventory] PAYMENT_FAILED event missing releasable items`
      );
      return;
    }

    for (const item of normalizedItems) {
      const { productId, quantity } = item || {};
      const normalizedQuantity = Number(quantity);

      if (!productId || !Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
        logger.warn(
          {
            orderId,
            productId,
            quantity,
            messageId,
          },
          `[Inventory] Skipping invalid compensation item`
        );
        continue;
      }

      try {
        await inventoryService.releaseReserved(productId, normalizedQuantity);
        logger.info(
          {
            orderId,
            productId,
            quantity: normalizedQuantity,
            messageId,
          },
          `[Inventory] Released reserved stock due to PAYMENT_FAILED`
        );
      } catch (error) {
        // Treat already-released items as idempotent success
        if (error.message?.includes("Cannot release")) {
          logger.warn(
            {
              orderId,
              productId,
              quantity: normalizedQuantity,
              messageId,
            },
            `[Inventory] Reservation already released, treating as idempotent`
          );
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * Publish message to a queue
   */
  async publishMessage(queue, message) {
    if (!this.channel) {
      logger.error("[Inventory] No RabbitMQ channel available.");
      return;
    }

    try {
      await this.channel.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': `${queue}.dlq`
        }
      });
      await this.channel.assertQueue(`${queue}.dlq`, { durable: true });
      const correlationId = message?.data?.orderId || message?.orderId || undefined;
      const messageId = correlationId || String(Date.now());
      this.channel.sendToQueue(
        queue,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          messageId,
          correlationId,
          timestamp: Date.now(),
          headers: {
            'x-correlation-id': correlationId,
          },
        }
      );
      logger.info(`[Inventory] Published message to queue: ${queue}`);
    } catch (err) {
      logger.error(`[Inventory] Error publishing message: ${err.message}`);
    }
  }

  /**
   * Consume messages from a queue
   */
  async consumeMessage(queue, callback, options = {}) {
    if (!this.channel) {
      logger.error("[Inventory] No RabbitMQ channel available.");
      return;
    }

    const { idempotent = false, messageIdExtractor } = options;

    try {
      await this.channel.consume(
        queue,
        async (msg) => {
          if (msg === null) {
            return;
          }

          try {
            const content = msg.content.toString();
            const parsedContent = JSON.parse(content);
            const messageIdFromHeaders = msg.properties?.messageId;
            const extractedMessageId =
              messageIdFromHeaders ||
              (typeof messageIdExtractor === "function"
                ? messageIdExtractor(parsedContent, msg)
                : undefined) ||
              parsedContent?.eventId ||
              parsedContent?.id ||
              parsedContent?.messageId;

            if (idempotent) {
              if (!extractedMessageId) {
                logger.warn(
                  {
                    queue,
                  },
                  `[Inventory] Received idempotent message without messageId`
                );
              } else {
                const alreadyProcessed = await processedMessageRepository.hasProcessed(
                  extractedMessageId
                );
                if (alreadyProcessed) {
                  logger.warn(
                    {
                      queue,
                      messageId: extractedMessageId,
                    },
                    `[Inventory] Duplicate message detected, acking without processing`
                  );
                  this.channel.ack(msg);
                  return;
                }
              }
            }

            await callback(parsedContent, {
              messageId: extractedMessageId,
              raw: msg,
            });

            if (idempotent && extractedMessageId) {
              await processedMessageRepository.markProcessed(
                extractedMessageId,
                queue
              );
            }

            this.channel.ack(msg);
          } catch (error) {
            logger.error(
              `[Inventory] Error processing message from ${queue}: ${error.message}`
            );
            // Reject and don't requeue if there's a processing error
            this.channel.reject(msg, false);
          }
        },
        { noAck: false }
      );
      logger.info(`[Inventory] Started consuming from queue: ${queue}`);
    } catch (err) {
      logger.error(`[Inventory] Error consuming messages: ${err.message}`);
    }
  }

  /**
   * Close connection
   */
  async close() {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
      logger.info("[Inventory] RabbitMQ connection closed");
    } catch (error) {
      logger.error(`[Inventory] Error closing RabbitMQ: ${error.message}`);
    }
  }
}

module.exports = new MessageBroker();
