const express = require("express");
const httpProxy = require("http-proxy");
const config = require("./config");

const proxy = httpProxy.createProxyServer();
const app = express();

// Route requests to the auth service
app.use("/auth", (req, res) => {
  proxy.web(req, res, { target: config.authServiceUrl });
});

// Route requests to the product service
app.use("/products", (req, res) => {
  proxy.web(req, res, { target: config.productServiceUrl });
});

// Route requests to the order service
app.use("/orders", (req, res) => {
  proxy.web(req, res, { target: config.orderServiceUrl });
});

// Start the server
app.listen(config.port, () => {
  console.log(`✓ [API Gateway] Server started on port ${config.port}`);
  console.log(`✓ [API Gateway] Ready`);
  console.log(`   → Auth: ${config.authServiceUrl}`);
  console.log(`   → Product: ${config.productServiceUrl}`);
  console.log(`   → Order: ${config.orderServiceUrl}`);
});
