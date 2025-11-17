import { Broker } from '@ecommerce/message-broker';
import { z } from 'zod';
import logger from '@ecommerce/logger';

const broker = new Broker();

const stockReservedSchema = z.object({
  orderId: z.string(),
  userId: z.string(),
  totalPrice: z.number(),
});

broker.consume('STOCK_RESERVED', async (data, metadata) => {
  logger.info({ data, metadata }, 'Received STOCK_RESERVED event');

  // Simulate payment processing
  const isSuccess = Math.random() > 0.1;

  if (isSuccess) {
    logger.info({ orderId: data.orderId }, 'Payment successful');
    await broker.publish('PAYMENT_SUCCEEDED', {
      orderId: data.orderId,
    }, { eventId: metadata.eventId, correlationId: metadata.correlationId });
  } else {
    logger.error({ orderId: data.orderId }, 'Payment failed');
    await broker.publish('PAYMENT_FAILED', {
      orderId: data.orderId,
      reason: 'Insufficient funds',
    }, { eventId: metadata.eventId, correlationId: metadata.correlationId });
  }
}, stockReservedSchema);

process.on('SIGTERM', async () => {
  await broker.close();
  process.exit(0);
});
