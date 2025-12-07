// packages/tracing/index.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { trace, context } = require('@opentelemetry/api');

let sdk; // Giữ tham chiếu đến SDK

/**
 * Khởi tạo OpenTelemetry SDK
 * @param {string} serviceName Tên của service (ví dụ: 'api-gateway', 'order-service')
 * @param {string} jaegerEndpoint URL của Jaeger collector (mặc định: http://localhost:4318/v1/traces)
 */
const initTracing = (serviceName, jaegerEndpoint = 'http://localhost:4318/v1/traces') => {
  if (sdk) {
    console.log('⚠️  [Tracing] Already initialized.');
    return;
  }

  // Cấu hình exporter, trỏ đến Jaeger (hoặc OTel Collector)
  const exporter = new OTLPTraceExporter({
    url: jaegerEndpoint,
  });

  sdk = new NodeSDK({
    // Định danh service này trên Jaeger UI
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: exporter,
    // Tự động theo dõi (instrument) các thư viện phổ biến
    instrumentations: [
      getNodeAutoInstrumentations({
        // Tắt một số instrumentation không cần thiết nếu muốn
        '@opentelemetry/instrumentation-fs': {
          enabled: false,
        },
      }),
    ],
  });

  // Khởi động SDK
  try {
    sdk.start();
    console.log(`✓ [${serviceName}] Tracing initialized (Jaeger: ${jaegerEndpoint})`);
  } catch (error) {
    console.error(`✗ [${serviceName}] Failed to initialize tracing:`, error);
  }
  
  // Xử lý khi tắt ứng dụng
  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.log('✓ [Tracing] Shutdown complete.'))
      .catch((error) => console.error('✗ [Tracing] Shutdown error:', error))
      .finally(() => process.exit(0));
  });
};

/**
 * Get the current trace ID from active OpenTelemetry context
 * Useful for distributed tracing correlation across services
 * 
 * @returns {string|null} Trace ID or null if not in a trace context
 * 
 * @example
 * const { getCurrentTraceId } = require('@ecommerce/tracing');
 * const traceId = getCurrentTraceId();
 * // Use traceId as correlationId for events
 */
const getCurrentTraceId = () => {
  const activeSpan = trace.getSpan(context.active());
  return activeSpan?.spanContext()?.traceId || null;
};

/**
 * Get the current span ID from active OpenTelemetry context
 * 
 * @returns {string|null} Span ID or null if not in a trace context
 */
const getCurrentSpanId = () => {
  const activeSpan = trace.getSpan(context.active());
  return activeSpan?.spanContext()?.spanId || null;
};

/**
 * Get the current span context (traceId, spanId, traceFlags)
 * 
 * @returns {Object|null} Span context object or null if not in a trace context
 */
const getCurrentSpanContext = () => {
  const activeSpan = trace.getSpan(context.active());
  return activeSpan?.spanContext() || null;
};

module.exports = { 
  initTracing,
  getCurrentTraceId,
  getCurrentSpanId,
  getCurrentSpanContext,
  // Export OpenTelemetry API for services that need direct access
  // (e.g., for trace context propagation in API Gateway)
  trace,
  context,
  propagation: require('@opentelemetry/api').propagation,
};