#!/usr/bin/env node

/**
 * E2E Test: Inventory reacts to PAYMENT_FAILED events (idempotent release)
 *
 * Flow:
 * 1. Register + login
 * 2. Create product (initial stock recorded)
 * 3. Create order so inventory reserves stock
 * 4. Publish PAYMENT_FAILED event via @ecommerce/message-broker
 * 5. Verify inventory releases reserved stock back to available
 * 6. Re-publish the same eventId to confirm idempotent behaviour
 *
 * Usage:
 *   node tests/e2e-inventory-payment-failed.js
 *   API_BASE=http://localhost:3003 node tests/e2e-inventory-payment-failed.js
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { Broker } = require("../packages/message-broker");

const API_BASE = process.env.API_BASE || "http://localhost:3003";
const POLL_INTERVAL = 1000; // ms
const MAX_WAIT_TIME = 60000; // ms

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const fmt = (msg, color = colors.reset) => `${color}${msg}${colors.reset}`;
const log = (msg, color) => console.log(fmt(msg, color));
const step = (n, msg) => {
  log(`\n${"=".repeat(60)}`, colors.cyan);
  log(`[STEP ${n}] ${msg}`, colors.bright + colors.cyan);
  log("=".repeat(60), colors.cyan);
};
const ok = (msg) => log(`✓ ${msg}`, colors.green);
const info = (msg) => log(`  ${msg}`, colors.blue);
const fail = (msg) => log(`✗ ${msg}`, colors.red);

const logInventoryState = (stage, snapshot) => {
  info(
    `${stage} → available=${snapshot?.available ?? "?"}, reserved=${snapshot?.reserved ?? "?"}`
  );
};

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
    if (payload) {
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch (err) {
          json = { raw: data };
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on("error", reject);

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

async function waitForInventory(productId, token, predicate, timeoutMs, label) {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    try {
      const { status, data } = await request(
        "GET",
        `/inventory/${productId}`,
        null,
        token
      );

      if (status === 200 && predicate(data)) {
        return data;
      }
      info(
        `${label || "inventory"} check #${attempt} → status=${status} body=${JSON.stringify(
          data
        )}`
      );
    } catch (error) {
      info(`${label || "inventory"} check #${attempt} failed: ${error.message}`);
    }

    await sleep(POLL_INTERVAL);
  }

  throw new Error(
    `${label || "inventory"} condition not met within ${timeoutMs}ms`
  );
}

async function waitForOrderStatus(orderId, token, targetStatus, timeoutMs) {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    const { status, data } = await request(
      "GET",
      `/orders/${orderId}`,
      null,
      token
    );

    if (status === 200) {
      info(`Order poll #${attempt}: status=${data.status}`);
      if (data.status === targetStatus) {
        return data;
      }
    } else {
      info(`Order poll #${attempt}: status=${status}`);
    }

    await sleep(POLL_INTERVAL);
  }

  throw new Error(
    `Order ${orderId} did not reach status ${targetStatus} within ${timeoutMs}ms`
  );
}

async function run() {
  const username = `e2e_payfail_${Date.now()}`;
  const password = "SecureP@ssw0rd123";
  const initialStock = 6;
  const orderQty = 4;

  let token;
  let productId;
  let orderId;
  const broker = new Broker();

  log("\n" + "█".repeat(60), colors.bright + colors.green);
  log(
    "  E2E TEST: Inventory handles PAYMENT_FAILED (idempotent release)",
    colors.bright + colors.green
  );
  log("█".repeat(60) + "\n", colors.bright + colors.green);
  info(`API Base: ${API_BASE}`);
  info(`Username: ${username}`);

  try {
    // 1) Register user
    step(1, "Register user");
    {
      const { status, data } = await request("POST", "/auth/register", {
        username,
        password,
      });
      if (status === 200 || status === 201) {
        ok("User registered");
      } else if (status === 400 && data.message?.includes("already")) {
        ok("User already exists, continuing");
      } else {
        fail(`Register failed: status=${status}`);
        info(JSON.stringify(data));
        throw new Error("register-failed");
      }
    }

    // 2) Login
    step(2, "Login to obtain JWT");
    {
      const { status, data } = await request("POST", "/auth/login", {
        username,
        password,
      });
      if (status !== 200 || !data.token) {
        fail(`Login failed: status=${status}`);
        info(JSON.stringify(data));
        throw new Error("login-failed");
      }
      token = data.token;
      ok("Authenticated");
    }

    // 3) Create product
    step(3, "Create product and wait for inventory record");
    {
      const body = {
        name: `E2E PaymentFail Product ${Date.now()}`,
        price: 25,
        description: "PAYMENT_FAILED compensation flow",
        available: initialStock,
      };
      const { status, data } = await request("POST", "/products", body, token);
      if (status !== 201) {
        fail(`Create product failed: status=${status}`);
        info(JSON.stringify(data));
        throw new Error("create-product-failed");
      }
      productId = data._id || data.id;
      if (!productId) {
        throw new Error("product-id-missing");
      }
      ok(`Product created (${productId})`);

      const initialInv = await waitForInventory(
        productId,
        token,
        (inv) => Number(inv?.available) === initialStock,
        MAX_WAIT_TIME,
        "inventory-initial"
      );
      ok("Inventory initialized with expected stock");
      logInventoryState("Initial inventory", initialInv);
    }

    // 4) Create order and wait until CONFIRMED (inventory reserved)
    step(4, "Create order to reserve stock");
    {
      const body = {
        productIds: [productId],
        quantities: [orderQty],
      };
      const { status, data } = await request("POST", "/orders", body, token);
      if (status !== 201) {
        fail(`Create order failed: status=${status}`);
        info(JSON.stringify(data));
        throw new Error("create-order-failed");
      }
      orderId = data.orderId;
      if (!orderId) {
        throw new Error("order-id-missing");
      }
      ok(`Order created (${orderId})`);

      await waitForOrderStatus(orderId, token, "CONFIRMED", MAX_WAIT_TIME);
      ok("Order reached CONFIRMED (inventory reserved)");

      const afterReserve = await waitForInventory(
        productId,
        token,
        (inv) =>
          Number(inv?.available) === initialStock - orderQty &&
          Number(inv?.reserved) >= orderQty,
        MAX_WAIT_TIME,
        "inventory-reserved"
      );
      logInventoryState("After reservation", afterReserve);
    }

    // 5) Publish PAYMENT_FAILED event
    step(5, "Publish PAYMENT_FAILED event");
    const eventId = crypto.randomUUID();
    const payload = {
      orderId,
      reason: "CARD_DECLINED",
      products: [{ productId, quantity: orderQty }],
    };
    await broker.publish("PAYMENT_FAILED", payload, {
      eventId,
      correlationId: orderId,
    });
    ok("PAYMENT_FAILED event published");

    const postComp = await waitForInventory(
      productId,
      token,
      (inv) => Number(inv?.available) === initialStock && Number(inv?.reserved) === 0,
      MAX_WAIT_TIME,
      "inventory-release"
    );
    ok("Inventory released reservation back to available stock");
    logInventoryState("After PAYMENT_FAILED compensation", postComp);

    // 6) Send duplicate event to ensure idempotency
    step(6, "Re-publish same eventId to verify idempotency");
    await broker.publish("PAYMENT_FAILED", payload, {
      eventId,
      correlationId: orderId,
    });
    ok("Duplicate PAYMENT_FAILED published (should be ignored)");

    await sleep(2000);
    const afterDuplicate = await request("GET", `/inventory/${productId}`, null, token);
    if (
      afterDuplicate.status !== 200 ||
      Number(afterDuplicate.data.available) !== initialStock ||
      Number(afterDuplicate.data.reserved) !== 0
    ) {
      fail(
        `Inventory changed after duplicate event: status=${afterDuplicate.status} body=${JSON.stringify(
          afterDuplicate.data
        )}`
      );
      throw new Error("idempotency-failed");
    }
    ok("Inventory unchanged after duplicate event");
    logInventoryState("After duplicate PAYMENT_FAILED", afterDuplicate.data);

    // Success banner
    log("\n" + "█".repeat(60), colors.bright + colors.green);
    log("  ✓ PAYMENT_FAILED inventory test PASSED", colors.bright + colors.green);
    log("█".repeat(60) + "\n", colors.bright + colors.green);
    await broker.close();
    process.exit(0);
  } catch (error) {
    log("\n" + "█".repeat(60), colors.bright + colors.red);
    log("  ✗ PAYMENT_FAILED inventory test FAILED", colors.bright + colors.red);
    log("█".repeat(60), colors.bright + colors.red);
    fail(error.message);
    if (error.stack) {
      log("\nStack trace:", colors.yellow);
      console.error(error.stack);
    }
    try {
      await broker.close();
    } catch (closeErr) {
      info(`Broker close error: ${closeErr.message}`);
    }
    process.exit(1);
  }
}

run();
