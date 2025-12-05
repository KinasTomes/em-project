/**
 * Seckill Service - OpenTelemetry Tracing Utilities
 * 
 * Provides manual tracing spans for Redis operations and message publishing.
 * Uses @opentelemetry/api for creating spans.
 * 
 * Requirements: 6.2
 */

const { trace, SpanStatusCode, context } = require('@opentelemetry/api')

// Get tracer for seckill service
const tracer = trace.getTracer('seckill-service')

/**
 * Create a span for Redis operations
 * @param {string} operation - Redis operation name (e.g., 'evalSha', 'get', 'set')
 * @param {Object} attributes - Additional span attributes
 * @returns {Object} Span object
 */
function startRedisSpan(operation, attributes = {}) {
  const span = tracer.startSpan(`redis.${operation}`, {
    attributes: {
      'db.system': 'redis',
      'db.operation': operation,
      ...attributes,
    },
  })
  return span
}

/**
 * Create a span for Lua script execution
 * @param {string} scriptName - Lua script name (e.g., 'reserve', 'release')
 * @param {Object} attributes - Additional span attributes
 * @returns {Object} Span object
 */
function startLuaScriptSpan(scriptName, attributes = {}) {
  const span = tracer.startSpan(`redis.lua.${scriptName}`, {
    attributes: {
      'db.system': 'redis',
      'db.operation': 'evalsha',
      'db.lua.script': scriptName,
      ...attributes,
    },
  })
  return span
}

/**
 * Create a span for message publishing
 * @param {string} eventType - Event type being published (e.g., 'seckill.order.won')
 * @param {Object} attributes - Additional span attributes
 * @returns {Object} Span object
 */
function startPublishSpan(eventType, attributes = {}) {
  const span = tracer.startSpan(`publish.${eventType}`, {
    attributes: {
      'messaging.system': 'rabbitmq',
      'messaging.operation': 'publish',
      'messaging.destination': eventType,
      ...attributes,
    },
  })
  return span
}

/**
 * End a span with success status
 * @param {Object} span - Span to end
 * @param {Object} attributes - Additional attributes to set before ending
 */
function endSpanSuccess(span, attributes = {}) {
  if (span) {
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value)
    })
    span.setStatus({ code: SpanStatusCode.OK })
    span.end()
  }
}

/**
 * End a span with error status
 * @param {Object} span - Span to end
 * @param {Error} error - Error that occurred
 * @param {Object} attributes - Additional attributes to set before ending
 */
function endSpanError(span, error, attributes = {}) {
  if (span) {
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value)
    })
    span.recordException(error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    span.end()
  }
}

/**
 * Execute a function within a span context
 * @param {string} spanName - Name of the span
 * @param {Object} attributes - Span attributes
 * @param {Function} fn - Async function to execute
 * @returns {Promise<*>} Result of the function
 */
async function withSpan(spanName, attributes, fn) {
  const span = tracer.startSpan(spanName, { attributes })
  const activeContext = trace.setSpan(context.active(), span)

  try {
    const result = await context.with(activeContext, fn)
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (error) {
    span.recordException(error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    throw error
  } finally {
    span.end()
  }
}

/**
 * Get the current trace ID from active context
 * @returns {string|null} Trace ID or null if not in a trace context
 */
function getCurrentTraceId() {
  const activeSpan = trace.getActiveSpan()
  if (activeSpan) {
    return activeSpan.spanContext().traceId
  }
  return null
}

/**
 * Get the current span ID from active context
 * @returns {string|null} Span ID or null if not in a trace context
 */
function getCurrentSpanId() {
  const activeSpan = trace.getActiveSpan()
  if (activeSpan) {
    return activeSpan.spanContext().spanId
  }
  return null
}

module.exports = {
  tracer,
  startRedisSpan,
  startLuaScriptSpan,
  startPublishSpan,
  endSpanSuccess,
  endSpanError,
  withSpan,
  getCurrentTraceId,
  getCurrentSpanId,
  SpanStatusCode,
}
