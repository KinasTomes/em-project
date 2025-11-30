/**
 * Payment Service - Service-Specific Metrics
 * 
 * Business metrics for payment processing operations.
 * Uses @ecommerce/metrics shared package for common metrics.
 */
const { promClient } = require('@ecommerce/metrics')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAYMENT PROCESSING METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Total payments processed
 * Labels:
 * - status: SUCCEEDED, FAILED, PENDING, PROCESSING
 * - payment_method: credit_card, debit_card, etc. (for future use)
 */
const paymentsProcessed = new promClient.Counter({
	name: 'payment_processed_total',
	help: 'Total payments processed',
	labelNames: ['status', 'payment_method'],
})

/**
 * Total payment amount processed (in cents/smallest currency unit)
 * Labels:
 * - currency: USD, EUR, etc.
 * - status: SUCCEEDED, FAILED
 */
const paymentAmount = new promClient.Counter({
	name: 'payment_amount_total',
	help: 'Total payment amount processed',
	labelNames: ['currency', 'status'],
})

/**
 * Payment processing duration
 * Time from receiving ORDER_CONFIRMED to publishing result event
 */
const paymentProcessingDuration = new promClient.Histogram({
	name: 'payment_processing_duration_seconds',
	help: 'Payment processing duration in seconds',
	labelNames: ['payment_method', 'status'],
	buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RETRY & ERROR METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Payment retry attempts
 * Labels:
 * - attempt_number: 1, 2, 3, etc.
 */
const paymentRetries = new promClient.Counter({
	name: 'payment_retries_total',
	help: 'Payment retry attempts',
	labelNames: ['attempt_number'],
})

/**
 * Payment gateway errors
 * Labels:
 * - error_code: GATEWAY_TIMEOUT, NETWORK_ERROR, PAYMENT_DECLINED, etc.
 */
const paymentGatewayErrors = new promClient.Counter({
	name: 'payment_gateway_errors_total',
	help: 'Payment gateway errors by error code',
	labelNames: ['error_code'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REFUND METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Total refunds processed
 * Labels:
 * - status: success, failed
 * - reason: customer_request, order_cancelled, etc.
 */
const refundsProcessed = new promClient.Counter({
	name: 'payment_refunds_total',
	help: 'Total refunds processed',
	labelNames: ['status', 'reason'],
})

/**
 * Total refund amount
 * Labels:
 * - currency: USD, EUR, etc.
 */
const refundAmount = new promClient.Counter({
	name: 'payment_refund_amount_total',
	help: 'Total refund amount processed',
	labelNames: ['currency'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EVENT PROCESSING METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Event processing operations
 * Labels:
 * - event_type: ORDER_CONFIRMED, PAYMENT_SUCCEEDED, PAYMENT_FAILED
 * - status: received, processed, skipped, failed
 */
const eventProcessing = new promClient.Counter({
	name: 'payment_event_processing_total',
	help: 'Payment event processing operations',
	labelNames: ['event_type', 'status'],
})

/**
 * Event processing duration
 * Labels:
 * - event_type: ORDER_CONFIRMED
 */
const eventProcessingDuration = new promClient.Histogram({
	name: 'payment_event_processing_duration_seconds',
	help: 'Duration of event processing in seconds',
	labelNames: ['event_type'],
	buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IDEMPOTENCY METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Idempotency check results
 * Labels:
 * - result: hit (duplicate detected), miss (new request)
 */
const idempotencyChecks = new promClient.Counter({
	name: 'payment_idempotency_checks_total',
	help: 'Idempotency check results',
	labelNames: ['result'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OUTBOX METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Outbox pending messages gauge
 */
const outboxPendingMessages = new promClient.Gauge({
	name: 'payment_outbox_pending_messages',
	help: 'Number of pending messages in payment outbox',
})

/**
 * Outbox event publishing
 * Labels:
 * - event_type: PAYMENT_SUCCEEDED, PAYMENT_FAILED
 * - status: queued, published, failed
 */
const outboxEvents = new promClient.Counter({
	name: 'payment_outbox_events_total',
	help: 'Outbox event operations',
	labelNames: ['event_type', 'status'],
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Record a payment processed
 */
function recordPaymentProcessed(status, paymentMethod = 'mock_gateway') {
	paymentsProcessed.inc({ status, payment_method: paymentMethod })
}

/**
 * Record payment amount
 */
function recordPaymentAmount(amount, currency, status) {
	paymentAmount.inc({ currency, status }, amount)
}

/**
 * Start timer for payment processing duration
 * @returns {function} End timer function
 */
function startPaymentProcessingTimer(paymentMethod = 'mock_gateway') {
	return paymentProcessingDuration.startTimer({ payment_method: paymentMethod })
}

/**
 * Record payment retry attempt
 */
function recordPaymentRetry(attemptNumber) {
	paymentRetries.inc({ attempt_number: String(attemptNumber) })
}

/**
 * Record gateway error
 */
function recordGatewayError(errorCode) {
	paymentGatewayErrors.inc({ error_code: errorCode })
}

/**
 * Record refund processed
 */
function recordRefund(status, reason, amount = 0, currency = 'USD') {
	refundsProcessed.inc({ status, reason })
	if (status === 'success' && amount > 0) {
		refundAmount.inc({ currency }, amount)
	}
}

/**
 * Record event processing
 */
function recordEventProcessing(eventType, status) {
	eventProcessing.inc({ event_type: eventType, status })
}

/**
 * Start timer for event processing duration
 * @returns {function} End timer function
 */
function startEventProcessingTimer(eventType) {
	return eventProcessingDuration.startTimer({ event_type: eventType })
}

/**
 * Record idempotency check result
 */
function recordIdempotencyCheck(isHit) {
	idempotencyChecks.inc({ result: isHit ? 'hit' : 'miss' })
}

/**
 * Update outbox pending messages count
 */
function setOutboxPendingMessages(count) {
	outboxPendingMessages.set(count)
}

/**
 * Record outbox event
 */
function recordOutboxEvent(eventType, status) {
	outboxEvents.inc({ event_type: eventType, status })
}

module.exports = {
	// Raw metrics
	paymentsProcessed,
	paymentAmount,
	paymentProcessingDuration,
	paymentRetries,
	paymentGatewayErrors,
	refundsProcessed,
	refundAmount,
	eventProcessing,
	eventProcessingDuration,
	idempotencyChecks,
	outboxPendingMessages,
	outboxEvents,

	// Helper functions
	recordPaymentProcessed,
	recordPaymentAmount,
	startPaymentProcessingTimer,
	recordPaymentRetry,
	recordGatewayError,
	recordRefund,
	recordEventProcessing,
	startEventProcessingTimer,
	recordIdempotencyCheck,
	setOutboxPendingMessages,
	recordOutboxEvent,
}
