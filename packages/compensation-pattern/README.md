# Compensation Pattern

Reusable compensation handler with retry logic, exponential backoff, and DLQ support for saga pattern implementations.

## Features

- ✅ **Automatic retry** with exponential backoff
- ✅ **Timeout protection** per attempt
- ✅ **Retryable vs non-retryable error detection**
- ✅ **DLQ integration** for failed compensations
- ✅ **Structured logging** with correlation IDs

## Usage

```javascript
const { CompensationHandler } = require("@ecommerce/compensation-pattern");

class ReleaseInventoryHandler extends CompensationHandler {
  async compensate(context, metadata) {
    // Your compensation logic
    await inventoryService.releaseReservation(
      context.productId,
      context.quantity
    );
  }
}

// Execute compensation
const handler = new ReleaseInventoryHandler({
  maxRetries: 3,
  initialRetryDelay: 1000,
  timeoutMs: 30000,
  dlqPublisher: broker, // Optional
});

const result = await handler.execute(
  { orderId: "123", productId: "456", quantity: 2 },
  { messageId: "msg-1", correlationId: "order-123" }
);

if (result.success) {
  console.log(`Succeeded after ${result.attempts} attempts`);
} else {
  console.error(`Failed: ${result.error}`);
}
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxRetries` | 3 | Maximum retry attempts |
| `initialRetryDelay` | 1000ms | Initial backoff delay |
| `maxRetryDelay` | 30000ms | Cap for exponential backoff |
| `backoffMultiplier` | 2 | Exponential factor |
| `timeoutMs` | 30000ms | Timeout per attempt |
| `dlqPublisher` | null | Broker for DLQ events |

## Error Classification

**Retryable errors:**
- Network errors (ECONNREFUSED, ETIMEDOUT)
- Timeout errors
- Transient database errors

**Non-retryable errors:**
- "not found"
- "does not exist"
- "invalid id"
- "validation error"
- "duplicate"
