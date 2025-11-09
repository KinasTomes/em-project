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

const proxy = httpProxy.createProxyServer();
const app = express();

// Route requests to the auth service
app.use("/auth", (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to auth service"
  );
  proxy.web(req, res, { target: config.authServiceUrl });
});

// Route requests to the product service
app.use("/products", (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to product service"
  );
  proxy.web(req, res, { target: config.productServiceUrl });
});

// Route requests to the order service
app.use("/orders", (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to order service"
  );
  proxy.web(req, res, { target: config.orderServiceUrl });
});

// Start the server
app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      jaegerEndpoint,
      routes: {
        auth: config.authServiceUrl,
        product: config.productServiceUrl,
        order: config.orderServiceUrl,
      },
    },
    "API Gateway started successfully"
  );
});
