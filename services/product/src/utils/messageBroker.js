// products/messaging/messageBroker.js
const amqp = require("amqplib");
const config = require("../config");
const logger = require("@ecommerce/logger");

const PRODUCTS_QUEUE = "products";

class MessageBroker {
  constructor() {
    this.connection = null;
    this.channel = null; // confirm channel
    this._connecting = false;
  }

  async connect() {
    return this.connectWithRetry();
  }

  async connectWithRetry(retries = 5, delay = 5000) {
    if (this._connecting) return;
    this._connecting = true;

    for (let i = 1; i <= retries; i++) {
      try {
        console.log(
          `⏳ [Product] Connecting to RabbitMQ... (Attempt ${i}/${retries})`
        );
        this.connection = await amqp.connect(config.rabbitMQURI);

        // confirm channel: cho phép chờ xác nhận message đã enqueue
        this.channel = await this.connection.createConfirmChannel();

        // durable queue để sống sót qua restart
        await this.channel.assertQueue(PRODUCTS_QUEUE, { durable: true });

        // cài đặt handler sự cố
        this.connection.on("error", (err) => {
          logger.error(`[Product] RabbitMQ connection error: ${err.message}`);
        });
        this.connection.on("close", () => {
          logger.warn("[Product] RabbitMQ connection closed. Reconnecting...");
          // thử reconnect nền (không throw)
          this._connecting = false;
          setTimeout(() => this.connectWithRetry().catch(() => {}), 2000);
        });

        console.log("✓ [Product] RabbitMQ connected");
        this._connecting = false;
        return;
      } catch (err) {
        console.error(
          `✗ [Product] Failed to connect to RabbitMQ: ${err.message}`
        );
        if (i < retries) {
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise((res) => setTimeout(res, delay));
        } else {
          console.error(
            "✗ [Product] Could not connect to RabbitMQ after all retries."
          );
          this._connecting = false;
        }
      }
    }
  }

  // Đảm bảo channel sẵn sàng trước khi publish
  async ensureConnected() {
    if (this.channel) return;
    await this.connectWithRetry();
    if (!this.channel)
      throw new Error("No RabbitMQ channel available after reconnect attempts");
  }

  // Hàm chuẩn hoá available: số nguyên >= 0, fallback 0 + log
  normalizeAvailable(raw) {
    if (raw === undefined || raw === null || raw === "") {
      logger.error(
        "[Product] Missing 'available' in PRODUCT_CREATED payload. Fallback to 0."
      );
      return 0;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      logger.warn(
        `[Product] Invalid 'available' value '${raw}'. Normalized to 0.`
      );
      return 0;
    }
    const floor = Math.floor(n);
    if (floor !== n) {
      logger.warn(
        `[Product] Normalized non-integer 'available' '${raw}' -> ${floor}.`
      );
    }
    return floor;
  }

  // API publish generic (nếu bạn vẫn cần)
  async publishMessage(queue, message) {
    await this.ensureConnected();

    try {
      await this.channel.assertQueue(queue, { durable: true });

      const payload = Buffer.from(JSON.stringify(message));
      this.channel.sendToQueue(queue, payload, {
        persistent: true,
        contentType: "application/json",
        headers: { eventType: message?.type || "UNKNOWN" },
      });

      // chờ xác nhận enqueue
      await this.channel.waitForConfirms();
      logger.info(
        `[Product] Published to ${queue}: ${message?.type || "UNKNOWN"}`
      );
    } catch (err) {
      logger.error(`[Product] Error publishing message: ${err.message}`);
      throw err;
    }
  }

  // === Contract rõ ràng cho PRODUCT_CREATED ===
  async publishProductCreated({ productId, available }) {
    await this.ensureConnected();

    if (!productId) {
      logger.error("[Product] publishProductCreated missing 'productId'");
      throw new Error("publishProductCreated missing productId");
    }

    const normalizedAvailable = this.normalizeAvailable(available);

    const msg = {
      type: "PRODUCT_CREATED",
      data: {
        productId: String(productId),
        available: normalizedAvailable, // ✅ BẮT BUỘC CÓ
        // Giữ backward-compat nếu Inventory cũ vẫn đọc initialStock
        initialStock: normalizedAvailable,
      },
      timestamp: new Date().toISOString(),
    };

    return this.publishMessage(PRODUCTS_QUEUE, msg);
  }

  // === Contract cho PRODUCT_DELETED ===
  async publishProductDeleted({ productId }) {
    await this.ensureConnected();

    if (!productId) {
      logger.error("[Product] publishProductDeleted missing 'productId'");
      throw new Error("publishProductDeleted missing productId");
    }

    const msg = {
      type: "PRODUCT_DELETED",
      data: { productId: String(productId) },
      timestamp: new Date().toISOString(),
    };

    return this.publishMessage(PRODUCTS_QUEUE, msg);
  }

  async close() {
    try {
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
      logger.info("[Product] RabbitMQ connection closed");
    } catch (error) {
      logger.error(`[Product] Error closing RabbitMQ: ${error.message}`);
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }

  // Nếu product service không cần consume thì có thể bỏ.
  async consumeMessage(/* queue, callback */) {
    logger.warn("[Product] consumeMessage not used in Product service.");
  }
}

module.exports = new MessageBroker();
