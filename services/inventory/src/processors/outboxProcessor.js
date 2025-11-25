const { OutboxProcessor } = require('@ecommerce/outbox-pattern');
const OutboxRepository = require('../repositories/outboxRepository');
const logger = require('@ecommerce/logger');

/**
 * Inventory Outbox Processor
 * Processes outbox events and publishes them to RabbitMQ
 */
class InventoryOutboxProcessor extends OutboxProcessor {
  constructor(messageBroker) {
    super({
      outboxRepository: OutboxRepository,
      messageBroker,
      batchSize: 50,
      pollInterval: 2000,
      useChangeStream: true,
      serviceName: 'inventory'
    });
  }

  /**
   * Map event types to routing keys
   */
  getRoutingKey(eventType) {
    const routingKeyMap = {
      'INVENTORY_RESERVED': 'inventory.reserved.success',
      'INVENTORY_RESERVE_FAILED': 'inventory.reserved.failed',
      'INVENTORY_RELEASED': 'inventory.released',
      'STOCK_UPDATED': 'inventory.updated',
      'INVENTORY_RESTOCKED': 'inventory.restocked'
    };

    return routingKeyMap[eventType] || 'inventory.unknown';
  }

  /**
   * Publish event to message broker
   */
  async publishEvent(outboxEvent) {
    try {
      const routingKey = this.getRoutingKey(outboxEvent.eventType);
      
      await this.messageBroker.publish(
        routingKey,
        outboxEvent.payload,
        {
          correlationId: outboxEvent.metadata.correlationId,
          messageId: outboxEvent._id.toString(),
          timestamp: outboxEvent.createdAt.getTime(),
          headers: {
            eventType: outboxEvent.eventType,
            aggregateId: outboxEvent.aggregateId,
            aggregateType: outboxEvent.aggregateType,
            service: 'inventory'
          }
        }
      );

      logger.info(
        { 
          eventId: outboxEvent._id, 
          eventType: outboxEvent.eventType,
          routingKey 
        }, 
        'Outbox event published to RabbitMQ'
      );

      return true;
    } catch (error) {
      logger.error(
        { 
          error: error.message, 
          eventId: outboxEvent._id,
          eventType: outboxEvent.eventType 
        }, 
        'Error publishing outbox event'
      );
      throw error;
    }
  }

  /**
   * Start the processor
   */
  async start() {
    try {
      logger.info('Starting Inventory Outbox Processor...');
      
      // Verify outbox collection indexes
      const Outbox = require('../models/outbox');
      await Outbox.collection.getIndexes();
      
      await super.start();
      logger.info('✓ Inventory Outbox Processor started successfully');
    } catch (error) {
      logger.error({ error: error.message }, 'Error starting Inventory Outbox Processor');
      throw error;
    }
  }

  /**
   * Stop the processor
   */
  async stop() {
    try {
      logger.info('Stopping Inventory Outbox Processor...');
      await super.stop();
      logger.info('✓ Inventory Outbox Processor stopped successfully');
    } catch (error) {
      logger.error({ error: error.message }, 'Error stopping Inventory Outbox Processor');
      throw error;
    }
  }

  /**
   * Get processor statistics
   */
  async getStats() {
    try {
      const baseStats = await super.getStats();
      const outboxStats = await OutboxRepository.getStats();
      
      // Get recent failures
      const recentFailures = await OutboxRepository.findRetryable(10);
      
      return {
        ...baseStats,
        outbox: outboxStats,
        recentFailures: recentFailures.map(f => ({
          eventId: f._id,
          eventType: f.eventType,
          retryCount: f.retryCount,
          lastError: f.lastError?.message
        }))
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Error getting processor stats');
      throw error;
    }
  }
}

module.exports = InventoryOutboxProcessor;
