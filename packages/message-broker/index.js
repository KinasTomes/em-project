// packages/message-broker/index.js
import { trace, propagation, context, SpanStatusCode } from '@opentelemetry/api'
import amqp from 'amqplib'
import { createClient } from 'redis'
import logger from '@ecommerce/logger'

const tracer = trace.getTracer('ecommerce-broker');

export class Broker {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.redisClient = null;
    this.isConnected = false;
    this.consumers = []; // Track registered consumers for re-registration
    this.exchangeName = process.env.EXCHANGE_NAME || 'ecommerce.events';
    
    logger.info('Broker initialized (connections will be established on first use)');
  }

  /**
   * Khởi tạo RabbitMQ connection
   */
  async _ensureRabbitMQConnection() {
    if (this.isConnected && this.connection && this.channel) {
      return;
    }

    const rabbitMQUrl = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
    const maxRetries = 5;
    const retryDelay = 5000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info({ attempt, rabbitMQUrl }, '⏳ Connecting to RabbitMQ...');
        
        this.connection = await amqp.connect(rabbitMQUrl);
        this.channel = await this.connection.createChannel();
        
        // Setup connection error handlers
        this.connection.on('error', (err) => {
          logger.error({ error: err.message }, '❌ RabbitMQ connection error');
          this.isConnected = false;
        });

        this.connection.on('close', async () => {
          logger.warn('⚠️  RabbitMQ connection closed. Auto-reconnecting...');
          this.isConnected = false;
          this.connection = null;
          this.channel = null;
          
          // Wait before reconnecting
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          try {
            await this._ensureRabbitMQConnection();
            // Re-register all consumers after reconnection
            await this._reregisterConsumers();
            logger.info('✓ RabbitMQ reconnected and consumers restored');
          } catch (error) {
            logger.error({ error: error.message }, '❌ Failed to auto-reconnect RabbitMQ');
          }
        });

        // Declare topic exchange for event routing
        await this.channel.assertExchange(this.exchangeName, 'topic', {
          durable: true
        });

        this.isConnected = true;
        logger.info({ exchange: this.exchangeName }, '✓ RabbitMQ connected and exchange declared');
        return;

      } catch (error) {
        logger.error({ 
          error: error.message, 
          attempt, 
          maxRetries 
        }, `❌ Failed to connect to RabbitMQ (attempt ${attempt}/${maxRetries})`);

        if (attempt === maxRetries) {
          throw new Error(`Failed to connect to RabbitMQ after ${maxRetries} attempts: ${error.message}`);
        }

        logger.info({ retryDelay }, `Retrying in ${retryDelay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  /**
   * Khởi tạo Redis connection
   */
  async _ensureRedisConnection() {
    if (this.redisClient && this.redisClient.isOpen) {
      return;
    }

    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    try {
      logger.info({ redisUrl }, '⏳ Connecting to Redis...');
      
      this.redisClient = createClient({ url: redisUrl });
      
      this.redisClient.on('error', (err) => {
        logger.error({ error: err.message }, '❌ Redis connection error');
      });

      this.redisClient.on('reconnecting', () => {
        logger.info('⏳ Reconnecting to Redis...');
      });

      await this.redisClient.connect();
      logger.info('✓ Redis connected successfully');

    } catch (error) {
      logger.error({ error: error.message }, '❌ Failed to connect to Redis');
      throw error;
    }
  }

  /**
   * Publish message to topic exchange with routing key
   * @param {string} routingKey - Routing key for message routing (e.g., 'order.confirmed')
   * @param {object} data - Message payload
   * @param {object} options - Publishing options
   * @param {string} options.eventId - Unique event ID
   * @param {string} options.correlationId - Correlation ID for tracing
   */
  async publish(routingKey, data, { eventId, correlationId }) {
    await this._ensureRabbitMQConnection();

    const span = tracer.startSpan(`publish-${routingKey}`);
    
    try {
      // Lấy active context và inject vào headers
      const activeContext = trace.setSpan(context.active(), span);
      const messageHeaders = {
        'x-correlation-id': correlationId || span.spanContext().traceId,
        'x-event-id': eventId,
        'x-routing-key': routingKey
      };

      // Inject OpenTelemetry context vào headers
      propagation.inject(activeContext, messageHeaders);

      // Publish message to exchange với retry logic
      const maxRetries = 3;
      let lastError;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const published = this.channel.publish(
            this.exchangeName,
            routingKey,
            Buffer.from(JSON.stringify(data)),
            {
              persistent: true,
              messageId: eventId,
              correlationId: correlationId || span.spanContext().traceId,
              timestamp: Date.now(),
              headers: messageHeaders
            }
          );

          if (!published) {
            throw new Error('Channel buffer full, message not published');
          }

          logger.info({ 
            eventId, 
            correlationId, 
            routingKey,
            exchange: this.exchangeName,
            traceId: span.spanContext().traceId
          }, '✓ Message published to exchange');

          span.setAttribute('event.id', eventId);
          span.setAttribute('routing.key', routingKey);
          span.setAttribute('exchange.name', this.exchangeName);
          span.setStatus({ code: SpanStatusCode.OK });
          
          return;

        } catch (error) {
          lastError = error;
          logger.warn({ 
            error: error.message, 
            attempt, 
            eventId 
          }, `⚠️  Publish attempt ${attempt} failed`);

          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }

      throw new Error(`Failed to publish after ${maxRetries} attempts: ${lastError.message}`);

    } catch (error) {
      logger.error({ 
        error: error.message, 
        eventId, 
        routingKey 
      }, '❌ Failed to publish message');

      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;

    } finally {
      span.end();
    }
  }

  /**
   * Re-register all consumers after reconnection
   * @private
   */
  async _reregisterConsumers() {
    if (this.consumers.length === 0) return;
    
    logger.info({ count: this.consumers.length }, '🔄 Re-registering consumers...');
    
    for (const { queue, handler, schema, routingKeys } of this.consumers) {
      try {
        await this._setupConsumer(queue, handler, schema, routingKeys);
        logger.info({ queue }, '✓ Consumer re-registered');
      } catch (error) {
        logger.error({ queue, error: error.message }, '❌ Failed to re-register consumer');
      }
    }
  }

  /**
   * Consume messages from queue bound to exchange with routing keys
   * @param {string} queue - Queue name (consumer's mailbox)
   * @param {function} handler - Message handler function
   * @param {object} schema - Optional Zod schema for validation
   * @param {string|string[]} routingKeys - Routing key pattern(s) to bind (e.g., '*.reserved', ['order.confirmed', 'order.cancelled'])
   */
  async consume(queue, handler, schema, routingKeys = []) {
    await this._ensureRabbitMQConnection();
    await this._ensureRedisConnection();
    
    // Normalize routingKeys to array
    const normalizedRoutingKeys = Array.isArray(routingKeys) ? routingKeys : [routingKeys];
    
    // Store consumer info for re-registration after reconnect
    const existingIndex = this.consumers.findIndex(c => c.queue === queue);
    if (existingIndex >= 0) {
      this.consumers[existingIndex] = { queue, handler, schema, routingKeys: normalizedRoutingKeys };
    } else {
      this.consumers.push({ queue, handler, schema, routingKeys: normalizedRoutingKeys });
    }
    
    await this._setupConsumer(queue, handler, schema, normalizedRoutingKeys);
  }

  /**
   * Setup consumer (internal, separated for re-registration)
   * @private
   */
  async _setupConsumer(queue, handler, schema, routingKeys = []) {

    if (!this.channel) {
      throw new Error('Channel not available');
    }

    // Assert queue exists
    await this.channel.assertQueue(queue, { 
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': `${queue}.dlq`
      }
    });

    // Assert DLQ exists
    await this.channel.assertQueue(`${queue}.dlq`, { durable: true });

    // Bind queue to exchange with routing keys
    if (routingKeys && routingKeys.length > 0) {
      for (const routingKey of routingKeys) {
        await this.channel.bindQueue(queue, this.exchangeName, routingKey);
        logger.info({ queue, exchange: this.exchangeName, routingKey }, '✓ Queue bound to exchange');
      }
    }

    // Set prefetch to 1 (process one message at a time)
    await this.channel.prefetch(1);

    logger.info({ queue, routingKeys }, '✓ Consumer registered, waiting for messages...');

    await this.channel.consume(queue, async (msg) => {
      if (!msg) return;

      const startTime = Date.now();
      let span;
      let eventId;

      try {
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // LAYER 0: Extract OpenTelemetry Context
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const extractedContext = propagation.extract(
          context.active(),
          msg.properties.headers || {}
        );

        span = tracer.startSpan(`consume-${queue}`, {}, extractedContext);
        const activeContext = trace.setSpan(context.active(), span);

        eventId = msg.properties.messageId;
        const correlationId = msg.properties.correlationId || msg.properties.headers?.['x-correlation-id'];

        logger.info({
          eventId,
          correlationId,
          queue,
          traceId: span.spanContext().traceId
        }, '⏳ Processing message...');

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // LAYER 1: Idempotency Check (Redis)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const processedKey = `processed:${eventId}`;
        const alreadyProcessed = await this.redisClient.get(processedKey);

        if (alreadyProcessed) {
          logger.warn({ eventId, correlationId }, '⚠️  Duplicate message detected, skipping');
          span.setAttribute('duplicate', true);
          span.setStatus({ code: SpanStatusCode.OK, message: 'Duplicate skipped' });
          this.channel.ack(msg);
          return;
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // LAYER 2: Schema Validation (Zod)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const rawData = JSON.parse(msg.content.toString());
        let validatedData = rawData;

        if (schema) {
          try {
            validatedData = schema.parse(rawData);
            span.setAttribute('schema.valid', true);
          } catch (validationError) {
            logger.error({
              error: validationError.message,
              eventId,
              rawData
            }, '❌ Schema validation failed, sending to DLQ');

            span.recordException(validationError);
            span.setAttribute('schema.valid', false);
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'Schema validation failed' });

            // Send to DLQ (don't requeue)
            this.channel.nack(msg, false, false);
            return;
          }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // LAYER 3: Execute Handler (Business Logic)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        await context.with(activeContext, async () => {
          await handler(validatedData, {
            eventId,
            correlationId,
            timestamp: msg.properties.timestamp,
            headers: msg.properties.headers,
            routingKey: msg.fields.routingKey // Include routing key for event type detection
          });
        });

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // LAYER 4: Mark as Processed (Redis) + ACK
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        await this.redisClient.set(processedKey, '1', {
          EX: 86400 // 24 hours TTL
        });

        this.channel.ack(msg);

        const duration = Date.now() - startTime;
        logger.info({
          eventId,
          correlationId,
          duration,
          queue
        }, '✓ Message processed successfully');

        span.setAttribute('processing.duration', duration);
        span.setStatus({ code: SpanStatusCode.OK });

      } catch (error) {
        const duration = Date.now() - startTime;
        
        logger.error({
          error: error.message,
          stack: error.stack,
          eventId,
          queue,
          duration
        }, '❌ Handler failed');

        if (span) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }

        // Classify error type
        const isTransientError = error.message?.includes('ECONNREFUSED') ||
                                error.message?.includes('timeout') ||
                                error.message?.includes('ETIMEDOUT');

        if (isTransientError) {
          // Transient error → Requeue for retry
          logger.warn({ eventId }, '⏳ Transient error, requeuing message...');
          this.channel.nack(msg, false, true);
        } else {
          // Permanent error → Send to DLQ
          logger.error({ eventId }, '❌ Permanent error, sending to DLQ');
          this.channel.nack(msg, false, false);
        }

      } finally {
        if (span) {
          span.end();
        }
      }
    });
  }

  /**
   * Graceful shutdown
   */
  async close() {
    logger.info('Closing MessageBroker connections...');

    try {
      if (this.channel) {
        await this.channel.close();
        logger.info('✓ RabbitMQ channel closed');
      }

      if (this.connection) {
        await this.connection.close();
        logger.info('✓ RabbitMQ connection closed');
      }

      if (this.redisClient) {
        await this.redisClient.quit();
        logger.info('✓ Redis connection closed');
      }

    } catch (error) {
      logger.error({ error: error.message }, 'Error during shutdown');
    }
  }
}

export default Broker