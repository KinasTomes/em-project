// Initialize OpenTelemetry FIRST (before any other imports)
const { initTracing } = require("@ecommerce/tracing");
const config = require("./config");

// Initialize tracing with service name and Jaeger endpoint
const jaegerEndpoint =
  process.env.JAEGER_ENDPOINT || "http://localhost:4318/v1/traces";
initTracing("api-gateway", jaegerEndpoint);

// Now import other modules (Express instrumentation will auto-instrument)
const express = require("express");
const httpProxy = require("http-proxy");
const logger = require("@ecommerce/logger");
const { metricsMiddleware, metricsHandler } = require("@ecommerce/metrics");
const gatewayMetrics = require("./metrics");

// OpenTelemetry for trace context propagation
const { trace, context, propagation } = require("@ecommerce/tracing");

// HTTP module for keep-alive agent
const http = require("http");

const keepAliveAgent = new http.Agent({
  keepAlive: true,        // <--- CHÌA KHÓA Ở ĐÂY: Đừng đóng kết nối
  maxSockets: 3000,       // Cho phép mở sẵn 3000 đường dây nóng (handle 2500 concurrent users)
  keepAliveMsecs: 1000    // Giữ đường dây 5s nếu không ai dùng
});

// Import middlewares
const {
  generalLimiter,
  authLimiter,
  devCors,
  strictCors,
  createValidator,
  conditionalAuth,
  getClientIp,
  circuitBreakerMiddleware,
  recordSuccess,
  recordFailure,
  getAllCircuitStats,
  getCircuitBreaker,
} = require("./middlewares");

const proxy = httpProxy.createProxyServer({ agent: keepAliveAgent });

// Track proxy request timing
const proxyTimers = new Map();

// Proxy request start handler - track timing AND inject trace context
proxy.on('proxyReq', (proxyReq, req, res) => {
  const requestId = req.headers['x-request-id'] || Date.now().toString();
  proxyTimers.set(requestId, {
    startTime: process.hrtime.bigint(),
    target: req.proxyTarget || 'unknown'
  });

  // ============================================
  // INJECT W3C TRACE CONTEXT INTO PROXY REQUEST
  // ============================================
  // This ensures trace context is propagated to downstream services
  // so they can continue the same trace (same traceId)
  const activeSpan = trace.getSpan(context.active());
  if (activeSpan) {
    const spanContext = activeSpan.spanContext();
    
    // Inject W3C Trace Context headers (traceparent, tracestate)
    // This allows downstream services to extract and continue the trace
    const carrier = {};
    propagation.inject(context.active(), carrier);
    
    // Set W3C Trace Context headers on proxy request
    // Check if headers already sent to avoid ERR_HTTP_HEADERS_SENT
    if (!res.headersSent) {
      Object.entries(carrier).forEach(([key, value]) => {
        try {
          proxyReq.setHeader(key, value);
        } catch (error) {
          // Ignore if headers already sent
          logger.debug({ error: error.message, key }, 'Failed to set proxy header (already sent)');
        }
      });
      
      // Also set custom headers for easier debugging/correlation
      try {
        proxyReq.setHeader('x-trace-id', spanContext.traceId);
        proxyReq.setHeader('x-span-id', spanContext.spanId);
      } catch (error) {
        logger.debug({ error: error.message }, 'Failed to set custom trace headers');
      }
      
      logger.debug({
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        target: req.proxyTarget,
        traceparent: carrier['traceparent'],
      }, '🔗 Trace context injected into proxy request');
    }
  }
});

// Proxy response handler - record metrics and circuit breaker state
proxy.on('proxyRes', (proxyRes, req, res) => {
  const requestId = req.headers['x-request-id'];
  const timerData = proxyTimers.get(requestId);
  
  if (timerData) {
    const endTime = process.hrtime.bigint();
    const durationSeconds = Number(endTime - timerData.startTime) / 1e9;
    
    gatewayMetrics.recordProxyRequest(
      timerData.target,
      req.method,
      proxyRes.statusCode,
      durationSeconds
    );
    
    // Mark service as healthy on successful response
    if (proxyRes.statusCode < 500) {
      gatewayMetrics.setUpstreamHealth(timerData.target, true);
      // Record success for circuit breaker
      recordSuccess(timerData.target);
    } else {
      // Record failure for circuit breaker (5xx errors)
      recordFailure(timerData.target, new Error(`HTTP ${proxyRes.statusCode}`));
    }
    
    proxyTimers.delete(requestId);
  }
});

// Proxy error handler
proxy.on('error', (err, req, res) => {
  const requestId = req.headers['x-request-id'];
  const timerData = proxyTimers.get(requestId);
  const targetService = timerData?.target || gatewayMetrics.getServiceFromUrl(req.url || '');
  
  // Record proxy error metric
  gatewayMetrics.recordProxyError(targetService, err.code);
  
  // Record failure for circuit breaker
  recordFailure(targetService, err);
  
  // Clean up timer
  if (requestId) {
    proxyTimers.delete(requestId);
  }

  logger.error(
    {
      error: err.message,
      code: err.code,
      target: req?.url,
      method: req?.method,
      service: targetService,
    },
    '❌ Proxy error - downstream service unavailable'
  );

  if (!res.headersSent) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
  }

  res.end(
    JSON.stringify({
      error: 'Service Unavailable',
      message: `Downstream service is not available: ${err.message}`,
      code: err.code,
      service: targetService,
    })
  );
});

const app = express();

// Trust proxy for correct IP detection behind load balancers
app.set('trust proxy', 1);

// ============================================
// GLOBAL MIDDLEWARES
// ============================================

// 1. CORS - Apply first to handle preflight requests
const corsMiddleware = config.nodeEnv === 'production' ? strictCors : devCors;
app.use(corsMiddleware);

// 1.5. Metrics middleware (early in chain for accurate timing)
app.use(metricsMiddleware('api-gateway'));

// 2. Request logging & tracking
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-ID', requestId);
  
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: getClientIp(req),
      requestId,
    }, 'Request completed');
  });
  
  next();
});

// 3. Request validation (body parsing, size limits, sanitization)
app.use(createValidator());

// 4. General rate limiting (applies to all routes)
app.use(generalLimiter);

// ============================================
// HEALTH CHECK (no auth required)
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================
// METRICS ENDPOINT (no auth required)
// ============================================
app.get('/metrics', metricsHandler);

// ============================================
// CIRCUIT BREAKER STATUS ENDPOINT
// ============================================
app.get('/circuit-breaker/status', (req, res) => {
  const stats = getAllCircuitStats();
  res.json({
    timestamp: new Date().toISOString(),
    circuits: stats,
  });
});

// ============================================
// INITIALIZE CIRCUIT BREAKERS FOR ALL SERVICES
// ============================================
const circuitBreakerOptions = {
  timeout: 10000,                    // 10s timeout
  errorThresholdPercentage: 50,      // Open if 50% fail
  resetTimeout: 30000,               // Try again after 30s
  volumeThreshold: 5,                // Min 5 requests before CB can trip
};

// Initialize circuit breakers for each service
['auth', 'product', 'order', 'inventory', 'payment', 'seckill'].forEach(service => {
  getCircuitBreaker(service, circuitBreakerOptions);
});

// ============================================
// AUTH SERVICE ROUTES
// ============================================

// Stricter rate limiting for auth endpoints (DDoS protection for login/register)
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);

// Route requests to the auth service
app.use("/auth", circuitBreakerMiddleware('auth'), (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to auth service"
  );
  req.proxyTarget = 'auth';
  proxy.web(req, res, { 
    target: config.authServiceUrl,
    timeout: config.proxy.timeout,
    proxyTimeout: config.proxy.proxyTimeout,
  });
});

// ============================================
// PRODUCT SERVICE ROUTES (Public read, Auth for write)
// ============================================
app.use("/products", circuitBreakerMiddleware('product'), (req, res, next) => {
  // GET requests are public
  if (req.method === 'GET') {
    return next();
  }
  // Other methods (POST, PUT, DELETE) require authentication
  conditionalAuth(req, res, next);
}, (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to product service"
  );
  let suffix = "";
  if (req.url === "/") {
    suffix = "";
  } else if (req.url.startsWith("/?")) {
    suffix = `?${req.url.slice(2)}`;
  } else {
    suffix = req.url;
  }
  req.url = `/api/products${suffix}`;
  req.proxyTarget = 'product';
  proxy.web(req, res, { 
    target: config.productServiceUrl,
    timeout: config.proxy.timeout,
    proxyTimeout: config.proxy.proxyTimeout,
  });
});

// ============================================
// ORDER SERVICE ROUTES (Requires authentication)
// ============================================
app.use("/orders", circuitBreakerMiddleware('order'), conditionalAuth, (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to order service"
  );
  let suffix = "";
  if (req.url === "/") {
    suffix = "";
  } else if (req.url.startsWith("/?")) {
    suffix = `?${req.url.slice(2)}`;
  } else {
    suffix = req.url;
  }
  req.url = `/api/orders${suffix}`;
  req.proxyTarget = 'order';
  proxy.web(req, res, { 
    target: config.orderServiceUrl,
    timeout: config.proxy.timeout,
    proxyTimeout: config.proxy.proxyTimeout,
  });
});

// ============================================
// INVENTORY SERVICE ROUTES (Fixed: Using config instead of hardcoded URL)
// ============================================
app.use("/inventory", circuitBreakerMiddleware('inventory'), (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to inventory service"
  );
  let suffix = "";
  if (req.url === "/") {
    suffix = "";
  } else if (req.url.startsWith("/?")) {
    suffix = `?${req.url.slice(2)}`;
  } else {
    suffix = req.url;
  }
  req.url = `/api/inventory${suffix}`;
  req.proxyTarget = 'inventory';
  // Fixed: Using config.inventoryServiceUrl instead of hardcoded URL
  proxy.web(req, res, { 
    target: config.inventoryServiceUrl,
    timeout: config.proxy.timeout,
    proxyTimeout: config.proxy.proxyTimeout,
  });
});

// ============================================
// PAYMENT SERVICE ROUTES (Requires authentication)
// ============================================
app.use("/payments", circuitBreakerMiddleware('payment'), conditionalAuth, (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to payment service"
  );
  let suffix = "";
  if (req.url === "/") {
    suffix = "";
  } else if (req.url.startsWith("/?")) {
    suffix = `?${req.url.slice(2)}`;
  } else {
    suffix = req.url;
  }
  req.url = `/api/payments${suffix}`;
  req.proxyTarget = 'payment';
  proxy.web(req, res, { 
    target: config.paymentServiceUrl,
    timeout: config.proxy.timeout,
    proxyTimeout: config.proxy.proxyTimeout,
  });
});

// ============================================
// SECKILL SERVICE ROUTES (Flash Sale)
// ============================================
// POST /seckill/buy requires authentication (X-User-ID header set after JWT verification)
// GET /seckill/status/:productId is public
// Admin routes (/admin/seckill/*) require X-Admin-Key header (handled by seckill service)
app.use("/seckill", circuitBreakerMiddleware('seckill'), (req, res, next) => {
  // GET /status is public
  if (req.method === 'GET' && req.path.startsWith('/status')) {
    return next();
  }
  // POST /buy requires authentication
  if (req.method === 'POST' && req.path === '/buy') {
    return conditionalAuth(req, res, next);
  }
  // Other routes pass through (admin routes handled by seckill service)
  next();
}, (req, res) => {
  logger.info(
    { path: req.path, method: req.method, originalUrl: req.originalUrl },
    "Routing to seckill service"
  );
  // Restore full path for seckill service (Express strips the mount path)
  req.url = `/seckill${req.url}`;
  req.proxyTarget = 'seckill';
  proxy.web(req, res, { 
    target: config.seckillServiceUrl,
    timeout: config.proxy.timeout,
    proxyTimeout: config.proxy.proxyTimeout,
  });
});

// Admin seckill routes (separate path for clarity)
app.use("/admin/seckill", (req, res) => {
  logger.info(
    { path: req.path, method: req.method, originalUrl: req.originalUrl },
    "Routing to seckill admin service"
  );
  // Restore full path for seckill service (Express strips the mount path)
  req.url = `/admin/seckill${req.url}`;
  req.proxyTarget = 'seckill';
  proxy.web(req, res, { 
    target: config.seckillServiceUrl,
    timeout: config.proxy.timeout,
    proxyTimeout: config.proxy.proxyTimeout,
  });
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  }, 'Unhandled error');

  res.status(err.status || 500).json({
    error: err.name || 'Internal Server Error',
    message: config.nodeEnv === 'production' 
      ? 'An unexpected error occurred' 
      : err.message,
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(config.port, '0.0.0.0', () => {
  logger.info(
    {
      port: config.port,
      environment: config.nodeEnv,
      jaegerEndpoint,
      routes: {
        auth: config.authServiceUrl,
        product: config.productServiceUrl,
        order: config.orderServiceUrl,
        inventory: config.inventoryServiceUrl,
        payment: config.paymentServiceUrl,
        seckill: config.seckillServiceUrl,
      },
      features: {
        rateLimiting: config.rateLimiting.enabled ? 'enabled' : 'DISABLED (load test mode)',
        cors: config.nodeEnv === 'production' ? 'strict' : 'development',
        authentication: 'centralized',
        requestValidation: 'enabled',
        metrics: 'enabled',
        circuitBreaker: 'enabled (50% threshold, 30s reset)',
      },
    },
    "🚀 API Gateway started successfully"
  );
});
