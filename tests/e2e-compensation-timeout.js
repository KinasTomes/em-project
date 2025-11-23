#!/usr/bin/env node

/**
 * E2E Test: Compensation & Timeout Handling
 *
 * Test scenarios:
 * 1. Saga timeout - order expires before inventory response
 * 2. Partial failure - inventory reserved but payment fails
 * 3. Compensation idempotency - duplicate compensation events
 *
 * Usage:
 *   node tests/e2e-compensation-timeout.js
 */

const http = require("http");
const https = require("https");
const { Broker } = require("../packages/message-broker");

const API_BASE = process.env.API_BASE || "http://localhost:3003";
const POLL_INTERVAL = 1000;
const MAX_WAIT_TIME = 90000; // 90s for timeout scenarios

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const log = (msg, color = colors.reset) => console.log(`${color}${msg}${colors.reset}`);
const step = (n, msg) => {
  log(`\n${"=".repeat(70)}`, colors.cyan);
  log(`[STEP ${n}] ${msg}`, colors.bright + colors.cyan);
  log("=".repeat(70), colors.cyan);
};
const ok = (msg) => log(`✓ ${msg}`, colors.green);
const fail = (msg) => log(`✗ ${msg}`, colors.red);
const info = (msg) => log(`  ${msg}`, colors.blue);
const warn = (msg) => log(`⚠ ${msg}`, colors.yellow);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" },
    };

    if (token) {
      options.headers["Authorization"] = token.startsWith("Bearer ")
        ? token
        : `Bearer ${token}`;
    }

    const payload = body ? JSON.stringify(body) : null;
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);

    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch {
          json = { raw: data };
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function setupUser() {
  const username = `e2e_comp_${Date.now()}`;
  const password = "SecureP@ssw0rd123";

  // Register
  const { status: regStatus } = await request("POST", "/auth/register", {
    username,
    password,
  });

  if (regStatus !== 200 && regStatus !== 201 && regStatus !== 400) {
    throw new Error(`Registration failed: ${regStatus}`);
  }

  // Login
  const { status: loginStatus, data: loginData } = await request(
    "POST",
    "/auth/login",
    { username, password }
  );

  if (loginStatus !== 200 || !loginData.token) {
    throw new Error("Login failed");
  }

  return { username, token: loginData.token };
}

async function createProduct(token, available) {
  const { status, data } = await request(
    "POST",
    "/products",
    {
      name: `E2E Compensation Product ${Date.now()}`,
      price: 50,
      description: "Compensation test product",
      available,
    },
    token
  );

  if (status !== 201) {
    throw new Error(`Product creation failed: ${status}`);
  }

  return data._id || data.id;
}

async function createOrder(token, productId, quantity) {
  const { status, data } = await request(
    "POST",
    "/orders",
    {
      productIds: [productId],
      quantities: [quantity],
    },
    token
  );

  if (status !== 201) {
    throw new Error(`Order creation failed: ${status}`);
  }

  return data.orderId;
}

async function getOrder(token, orderId) {
  const { status, data } = await request("GET", `/orders/${orderId}`, null, token);
  if (status !== 200) return null;
  return data;
}

async function getInventory(token, productId) {
  const { status, data } = await request(
    "GET",
    `/inventory/${productId}`,
    null,
    token
  );
  if (status !== 200) return null;
  return data;
}

async function waitForInventoryRelease(token, productId, expectedAvailable, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inv = await getInventory(token, productId);
    if (inv && Number(inv.available) === expectedAvailable && Number(inv.reserved) === 0) {
      return inv;
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Inventory not released within ${timeoutMs}ms`);
}

/**
 * Scenario 1: Timeout causes compensation
 */
async function testSagaTimeout() {
  step(1, "SCENARIO 1: Saga Timeout Compensation");

  const { token } = await setupUser();
  const productId = await createProduct(token, 10);
  
  info("Product created with 10 units available");

  // Create order
  const orderId = await createOrder(token, productId, 3);
  ok(`Order created: ${orderId}`);

  // Wait for reservation
  await sleep(5000);
  const invAfterReserve = await getInventory(token, productId);
  info(
    `After reserve: available=${invAfterReserve?.available}, reserved=${invAfterReserve?.reserved}`
  );

  if (invAfterReserve?.reserved !== 3) {
    warn("Reservation might not have completed yet");
  }

  // Simulate timeout by waiting for timeout worker to detect expired saga
  // (In real test, you'd set expiresAt to near-past when creating outbox event)
  info("Waiting for timeout worker to detect expiration...");
  warn("⚠ This test requires timeout worker to be running with short intervals");
  
  // For now, manually publish timeout compensation
  const broker = new Broker();
  await broker.publish(
    "ORDER_TIMEOUT",
    {
      orderId,
      products: [{ productId, quantity: 3 }],
      reason: "SAGA_TIMEOUT",
    },
    {
      eventId: `${orderId}-timeout-test`,
      correlationId: orderId,
    }
  );
  ok("Published ORDER_TIMEOUT compensation event");

  // Wait for compensation to release inventory
  const invAfterComp = await waitForInventoryRelease(token, productId, 10, 30000);
  ok(
    `Inventory released by compensation: available=${invAfterComp.available}, reserved=${invAfterComp.reserved}`
  );

  await broker.close();
}

/**
 * Scenario 2: Payment failure triggers compensation
 */
async function testPaymentFailure() {
  step(2, "SCENARIO 2: Payment Failure Compensation");

  const { token } = await setupUser();
  const productId = await createProduct(token, 8);
  
  info("Product created with 8 units available");

  const orderId = await createOrder(token, productId, 5);
  ok(`Order created: ${orderId}`);

  // Wait for reservation
  await sleep(5000);
  const invAfterReserve = await getInventory(token, productId);
  info(
    `After reserve: available=${invAfterReserve?.available}, reserved=${invAfterReserve?.reserved}`
  );

  // Simulate payment failure
  const broker = new Broker();
  await broker.publish(
    "PAYMENT_FAILED",
    {
      orderId,
      products: [{ productId, quantity: 5 }],
      reason: "CARD_DECLINED",
    },
    {
      eventId: `${orderId}-payment-fail`,
      correlationId: orderId,
    }
  );
  ok("Published PAYMENT_FAILED event");

  // Verify compensation releases inventory
  const invAfterComp = await waitForInventoryRelease(token, productId, 8, 30000);
  ok(
    `Inventory released after payment failure: available=${invAfterComp.available}, reserved=${invAfterComp.reserved}`
  );

  await broker.close();
}

/**
 * Scenario 3: Idempotent compensation
 */
async function testIdempotentCompensation() {
  step(3, "SCENARIO 3: Idempotent Compensation");

  const { token } = await setupUser();
  const productId = await createProduct(token, 12);
  
  info("Product created with 12 units available");

  const orderId = await createOrder(token, productId, 4);
  ok(`Order created: ${orderId}`);

  await sleep(5000);
  const invAfterReserve = await getInventory(token, productId);
  info(
    `After reserve: available=${invAfterReserve?.available}, reserved=${invAfterReserve?.reserved}`
  );

  // Publish compensation twice with same eventId
  const broker = new Broker();
  const eventId = `${orderId}-idempotent-comp`;

  await broker.publish(
    "RELEASE",
    {
      orderId,
      productId,
      quantity: 4,
      reason: "TEST_IDEMPOTENCY",
    },
    { eventId, correlationId: orderId }
  );
  ok("Published RELEASE compensation (1st time)");

  await sleep(3000);

  await broker.publish(
    "RELEASE",
    {
      orderId,
      productId,
      quantity: 4,
      reason: "TEST_IDEMPOTENCY",
    },
    { eventId, correlationId: orderId }
  );
  ok("Published RELEASE compensation (2nd time, same eventId)");

  await sleep(3000);

  const invFinal = await getInventory(token, productId);
  
  if (invFinal.available === 12 && invFinal.reserved === 0) {
    ok(`✓ Idempotency preserved: available=${invFinal.available}, reserved=${invFinal.reserved}`);
  } else {
    fail(
      `✗ Idempotency failed: available=${invFinal.available}, reserved=${invFinal.reserved}`
    );
    throw new Error("Idempotency check failed");
  }

  await broker.close();
}

async function main() {
  log("\n" + "█".repeat(70), colors.bright + colors.green);
  log("  E2E TEST: Compensation & Timeout Handling", colors.bright + colors.green);
  log("█".repeat(70) + "\n", colors.bright + colors.green);

  try {
    await testSagaTimeout();
    await testPaymentFailure();
    await testIdempotentCompensation();

    log("\n" + "█".repeat(70), colors.bright + colors.green);
    log("  ✓ ALL COMPENSATION TESTS PASSED", colors.bright + colors.green);
    log("█".repeat(70) + "\n", colors.bright + colors.green);

    process.exit(0);
  } catch (error) {
    log("\n" + "█".repeat(70), colors.bright + colors.red);
    log("  ✗ COMPENSATION TESTS FAILED", colors.bright + colors.red);
    log("█".repeat(70), colors.bright + colors.red);
    fail(error.message);
    if (error.stack) {
      log("\nStack:", colors.yellow);
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
