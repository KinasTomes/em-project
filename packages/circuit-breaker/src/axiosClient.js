const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const { trace, context } = require('@opentelemetry/api');
const logger = require('@ecommerce/logger');

/**
 * Create an axios instance with retry logic and tracing
 * @param {string} serviceName - Name of the target service
 * @param {string} baseURL - Base URL for the service
 * @param {Object} config - Configuration object
 * @returns {AxiosInstance} Configured axios instance
 */
function createAxiosClient(serviceName, baseURL, config) {
  // Create axios instance with base configuration
  const axiosInstance = axios.create({
    baseURL,
    timeout: config.timeout,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Configure axios-retry
  axiosRetry(axiosInstance, {
    retries: config.retry.retries,
    retryDelay: config.retry.retryDelay,
    retryCondition: config.retry.retryCondition,
    shouldResetTimeout: config.retry.shouldResetTimeout,
    onRetry: (retryCount, error, requestConfig) => {
      logger.warn(
        {
          service: serviceName,
          url: requestConfig.url,
          method: requestConfig.method,
          retryCount,
          error: error.message,
          status: error.response?.status,
        },
        `[CircuitBreaker] Retrying request (attempt ${retryCount}/${config.retry.retries})`
      );
    },
  });

  // Request interceptor: Inject trace ID
  axiosInstance.interceptors.request.use(
    (requestConfig) => {
      // Get current trace context from OpenTelemetry
      const span = trace.getSpan(context.active());
      
      if (span) {
        const spanContext = span.spanContext();
        // Inject trace ID into headers
        requestConfig.headers['x-trace-id'] = spanContext.traceId;
        requestConfig.headers['x-span-id'] = spanContext.spanId;
      }

      logger.debug(
        {
          service: serviceName,
          url: requestConfig.url,
          method: requestConfig.method,
          traceId: requestConfig.headers['x-trace-id'],
        },
        '[CircuitBreaker] Outgoing request'
      );

      return requestConfig;
    },
    (error) => {
      logger.error(
        { service: serviceName, error: error.message },
        '[CircuitBreaker] Request interceptor error'
      );
      return Promise.reject(error);
    }
  );

  // Response interceptor: Log responses
  axiosInstance.interceptors.response.use(
    (response) => {
      logger.debug(
        {
          service: serviceName,
          url: response.config.url,
          method: response.config.method,
          status: response.status,
        },
        '[CircuitBreaker] Response received'
      );
      return response;
    },
    (error) => {
      logger.error(
        {
          service: serviceName,
          url: error.config?.url,
          method: error.config?.method,
          status: error.response?.status,
          error: error.message,
        },
        '[CircuitBreaker] Request failed'
      );
      return Promise.reject(error);
    }
  );

  return axiosInstance;
}

module.exports = { createAxiosClient };
