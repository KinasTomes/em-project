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

proxy.on('error', (err, req, res) => {
	logger.error(
		{
			error: err.message,
			code: err.code,
			target: req?.url,
			method: req?.method,
		},
		'❌ Proxy error - downstream service unavailable'
	)

	if (!res.headersSent) {
		res.writeHead(503, { 'Content-Type': 'application/json' })
	}

	res.end(
		JSON.stringify({
			error: 'Service Unavailable',
			message: `Downstream service is not available: ${err.message}`,
			code: err.code,
		})
	)
})

const app = express();

// Route requests to the auth service
app.use("/auth", (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to auth service"
  );
  proxy.web(req, res, { 
    target: config.authServiceUrl,
    timeout: 10000,
    proxyTimeout: 10000,
  });
});

// Route requests to the product service
app.use("/products", (req, res) => {
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
  proxy.web(req, res, { 
    target: config.productServiceUrl,
    timeout: 10000,
    proxyTimeout: 10000,
  });
});

// Route requests to the order service
app.use("/orders", (req, res) => {
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
  proxy.web(req, res, { 
    target: config.orderServiceUrl,
    timeout: 10000,
    proxyTimeout: 10000,
  });
});

// Route requests to the inventory service
app.use("/inventory", (req, res) => {
  logger.info(
    { path: req.path, method: req.method },
    "Routing to inventory service"
  );
  const inventoryServiceUrl =
    process.env.INVENTORY_SERVICE_URL || "http://inventory:3005";
  let suffix = "";
  if (req.url === "/") {
    suffix = "";
  } else if (req.url.startsWith("/?")) {
    suffix = `?${req.url.slice(2)}`;
  } else {
    suffix = req.url;
  }
  req.url = `/api/inventory${suffix}`;
  proxy.web(req, res, { 
    target: inventoryServiceUrl,
    timeout: 10000,
    proxyTimeout: 10000,
  });
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
