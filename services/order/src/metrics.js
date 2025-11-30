/**
 * Order Service - Business Metrics
 * 
 * Metrics specific to order operations, state machine, saga patterns
 */

const { promClient } = require('@ecommerce/metrics');

// Orders created counter
const ordersCreated = new promClient.Counter({
  name: 'order_created_total',
  help: 'Total orders created',
  labelNames: ['status'] // pending, confirmed, failed
});

// Order state transitions counter
const orderStateTransitions = new promClient.Counter({
  name: 'order_state_transitions_total',
  help: 'Order state machine transitions',
  labelNames: ['from_state', 'to_state', 'trigger'] // trigger: inventory_reserved, inventory_failed, payment_success, payment_failed
});

// Order processing duration histogram
const orderProcessingDuration = new promClient.Histogram({
  name: 'order_processing_duration_seconds',
  help: 'Time from order creation to final state',
  labelNames: ['final_status'], // paid, cancelled
  buckets: [1, 5, 10, 30, 60, 120, 300, 600]
});

// Saga operations counter
const sagaOperations = new promClient.Counter({
  name: 'order_saga_operations_total',
  help: 'Saga pattern operations',
  labelNames: ['saga_type', 'step', 'status'] // saga_type: order_flow; step: create, reserve, payment; status: success, compensated, failed
});

// Circuit breaker state gauge
const circuitBreakerState = new promClient.Gauge({
  name: 'order_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['target_service']
});

// Outbox pending messages gauge
const outboxPendingMessages = new promClient.Gauge({
  name: 'order_outbox_pending_messages',
  help: 'Number of pending messages in outbox'
});

// Total order value counter
const orderValueTotal = new promClient.Counter({
  name: 'order_value_total',
  help: 'Total order value processed',
  labelNames: ['currency', 'status'] // status: created, confirmed, paid, cancelled
});

// Order operations counter (CRUD)
const orderOperations = new promClient.Counter({
  name: 'order_operations_total',
  help: 'Order CRUD operations',
  labelNames: ['operation', 'status'] // operation: create, read, list; status: success, failed, not_found
});

// Event processing counter
const eventProcessing = new promClient.Counter({
  name: 'order_event_processing_total',
  help: 'Order event processing operations',
  labelNames: ['event_type', 'status'] // event_type: inventory_reserved, inventory_failed, payment_success, payment_failed
});

// Event processing duration histogram
const eventProcessingDuration = new promClient.Histogram({
  name: 'order_event_processing_duration_seconds',
  help: 'Duration of event processing',
  labelNames: ['event_type'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

// Product validation duration histogram
const productValidationDuration = new promClient.Histogram({
  name: 'order_product_validation_duration_seconds',
  help: 'Duration of product validation calls',
  labelNames: ['status'], // success, circuit_open, timeout, failed
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5]
});

/**
 * Record an order creation
 * @param {'pending'|'confirmed'|'failed'} status 
 */
function recordOrderCreated(status) {
  ordersCreated.inc({ status });
}

/**
 * Record an order state transition
 * @param {string} fromState 
 * @param {string} toState 
 * @param {string} trigger 
 */
function recordStateTransition(fromState, toState, trigger) {
  orderStateTransitions.inc({
    from_state: fromState.toLowerCase(),
    to_state: toState.toLowerCase(),
    trigger
  });
}

/**
 * Start a timer for order processing duration
 * Call the returned function with final_status when order reaches final state
 * @returns {function} End timer function that takes finalStatus
 */
function startOrderProcessingTimer() {
  const startTime = Date.now();
  return (finalStatus) => {
    const duration = (Date.now() - startTime) / 1000;
    orderProcessingDuration.observe({ final_status: finalStatus.toLowerCase() }, duration);
  };
}

/**
 * Record a saga operation
 * @param {string} sagaType 
 * @param {string} step 
 * @param {'success'|'compensated'|'failed'} status 
 */
function recordSagaOperation(sagaType, step, status) {
  sagaOperations.inc({ saga_type: sagaType, step, status });
}

/**
 * Update circuit breaker state
 * @param {string} targetService 
 * @param {'CLOSED'|'OPEN'|'HALF_OPEN'} state 
 */
function updateCircuitBreakerState(targetService, state) {
  const stateValue = state === 'CLOSED' ? 0 : state === 'OPEN' ? 1 : 2;
  circuitBreakerState.set({ target_service: targetService }, stateValue);
}

/**
 * Update outbox pending messages count
 * @param {number} count 
 */
function setOutboxPendingMessages(count) {
  outboxPendingMessages.set(count);
}

/**
 * Record order value
 * @param {number} amount 
 * @param {string} currency 
 * @param {'created'|'confirmed'|'paid'|'cancelled'} status 
 */
function recordOrderValue(amount, currency, status) {
  orderValueTotal.inc({ currency, status }, amount);
}

/**
 * Record an order operation
 * @param {'create'|'read'|'list'} operation 
 * @param {'success'|'failed'|'not_found'} status 
 */
function recordOrderOperation(operation, status) {
  orderOperations.inc({ operation, status });
}

/**
 * Record event processing
 * @param {string} eventType 
 * @param {'success'|'failed'|'skipped'} status 
 */
function recordEventProcessing(eventType, status) {
  eventProcessing.inc({ event_type: eventType, status });
}

/**
 * Start a timer for event processing
 * @param {string} eventType 
 * @returns {function} End timer function
 */
function startEventProcessingTimer(eventType) {
  return eventProcessingDuration.startTimer({ event_type: eventType });
}

/**
 * Start a timer for product validation
 * @returns {function} End timer function that takes status
 */
function startProductValidationTimer() {
  const timer = productValidationDuration.startTimer();
  return (status) => timer({ status });
}

/**
 * Update circuit breaker metrics from stats
 * @param {Object} stats - Circuit breaker stats from productClient
 */
function updateCircuitBreakerFromStats(stats) {
  if (stats && stats.state) {
    updateCircuitBreakerState('product-service', stats.state);
  }
}

module.exports = {
  // Metrics
  ordersCreated,
  orderStateTransitions,
  orderProcessingDuration,
  sagaOperations,
  circuitBreakerState,
  outboxPendingMessages,
  orderValueTotal,
  orderOperations,
  eventProcessing,
  eventProcessingDuration,
  productValidationDuration,

  // Helper functions
  recordOrderCreated,
  recordStateTransition,
  startOrderProcessingTimer,
  recordSagaOperation,
  updateCircuitBreakerState,
  setOutboxPendingMessages,
  recordOrderValue,
  recordOrderOperation,
  recordEventProcessing,
  startEventProcessingTimer,
  startProductValidationTimer,
  updateCircuitBreakerFromStats
};
