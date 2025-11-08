// packages/message-broker/index.js
import { trace, propagation, context } from '@opentelemetry/api';
import logger from '@ecommerce/logger';

// TODO: Import amqp, redis...

const tracer = trace.getTracer('ecommerce-broker'); // OTel tracer

export class Broker {
  constructor() {
    // TODO: Khởi tạo connection (RabbitMQ, Redis)
    logger.info('Broker đang khởi tạo...');
  }

  /**
   * Gửi message
   */
  async publish(queue, data, { eventId }) {
    logger.info({ eventId, queue }, 'Đang publish message...');
    
    // TODO: Lấy OTel context
    const activeContext = context.active();
    const messageHeaders = {};

    // TODO: Inject OTel context vào messageHeaders
    propagation.inject(activeContext, messageHeaders);
    logger.info({ headers: messageHeaders }, 'Injected OTel headers');

    // TODO: Gửi message lên RabbitMQ với `messageHeaders`
  }

  /**
   * Nhận message
   */
  async consume(queue, handler, schema) {
    logger.info({ queue }, 'Đang đăng ký consumer...');

    // TODO: Đăng ký consumer với RabbitMQ
    const onMessage = async (msg) => {
      // TODO: Logic 4 lớp (Tracing, Idempotency, Schema, Handler)
      // 1. Extract OTel context từ msg.properties.headers
      // 2. Tạo span mới
      // 3. Check Idempotency (Redis)
      // 4. Validate schema (Zod)
      // 5. Gọi handler()
    };
  }
}