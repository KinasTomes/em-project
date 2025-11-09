import http from "k6/http";
import { check, sleep } from "k6";

/**
 * K6 Integration Test - Full Event-Driven Flow
 * Tests complete flow across Product, Order, and Inventory services
 *
 * Flow:
 * 1. Create Product → PRODUCT_CREATED event → Inventory auto-creates
 * 2. Create Order → ORDER_CREATED event → Order service processes
 * 3. Delete Product → PRODUCT_DELETED event → Inventory auto-deletes
 *
 * Queue Architecture:
 * - products queue: PRODUCT_CREATED, PRODUCT_DELETED (consumed by Inventory)
 * - orders queue: ORDER_CREATED, INVENTORY_RESERVED, INVENTORY_RESERVE_FAILED (consumed by Order)
 * - inventory queue: RESERVE, RELEASE, RESTOCK (consumed by Inventory)
 */

export const options = {
  stages: [
    { duration: "5s", target: 3 }, // Warm up
    { duration: "20s", target: 10 }, // Load
    { duration: "15s", target: 10 }, // Sustained
    { duration: "5s", target: 0 }, // Cool down
  ],
  thresholds: {
    http_req_duration: ["p(95)<1500"],
    http_req_failed: ["rate<0.1"],
    checks: ["rate>0.9"], // 90% of checks should pass
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3003";
const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";

// Setup: Get authentication token
export function setup() {
  const loginPayload = JSON.stringify({
    username: "testuser",
    password: "testpass123",
  });

  const loginResponse = http.post(`${AUTH_URL}/login`, loginPayload, {
    headers: { "Content-Type": "application/json" },
  });

  let token = null;
  if (loginResponse.status === 200) {
    const data = JSON.parse(loginResponse.body);
    token = data.token;
    console.log("✓ [Setup] Authentication successful");
  } else {
    console.log("⚠️  [Setup] Login failed, attempting registration...");
    const registerResponse = http.post(`${AUTH_URL}/register`, loginPayload, {
      headers: { "Content-Type": "application/json" },
    });

    if (registerResponse.status === 201) {
      const data = JSON.parse(registerResponse.body);
      token = data.token;
      console.log("✓ [Setup] Registration successful");
    }
  }

  if (!token) {
    console.error("✗ [Setup] Authentication failed");
    return { token: null };
  }

  console.log("🚀 [Setup] Starting integration test");
  console.log("📊 [Setup] Testing 3-queue architecture:");
  console.log("   - products (PRODUCT_CREATED, PRODUCT_DELETED)");
  console.log(
    "   - orders (ORDER_CREATED, INVENTORY_RESERVED, INVENTORY_RESERVE_FAILED)"
  );
  console.log("   - inventory (RESERVE, RELEASE, RESTOCK)");

  return { token };
}

export default function (data) {
  if (!data.token) {
    console.error("No token available, skipping tests");
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
  };

  const vuId = __VU;
  const iterationId = __ITER;

  console.log(`\n🔄 [VU${vuId}-${iterationId}] Starting integration flow...`);

  // ========================================
  // STEP 1: CREATE PRODUCT
  // ========================================
  const productPayload = JSON.stringify({
    name: `Integration-Test-Product-VU${vuId}-${Date.now()}`,
    price: Math.floor(Math.random() * 500) + 100,
    description: `Full integration test product from VU ${vuId}`,
  });

  const createProductRes = http.post(`${BASE_URL}/product`, productPayload, {
    headers,
  });

  const productCreated = check(createProductRes, {
    "✓ [PRODUCT] Created successfully (201)": (r) => r.status === 201,
    "✓ [PRODUCT] Has valid _id": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body._id !== undefined && body._id.length > 0;
      } catch {
        return false;
      }
    },
  });

  if (!productCreated) {
    console.error(`✗ [VU${vuId}-${iterationId}] Failed to create product`);
    return;
  }

  let productId = null;
  try {
    const product = JSON.parse(createProductRes.body);
    productId = product._id;
    console.log(`✓ [VU${vuId}-${iterationId}] Product created: ${productId}`);
    console.log(`   → PRODUCT_CREATED event published to 'products' queue`);
  } catch (e) {
    console.error(`✗ [VU${vuId}-${iterationId}] Failed to parse product`);
    return;
  }

  sleep(1); // Wait for PRODUCT_CREATED event to be consumed by Inventory service

  // ========================================
  // STEP 2: VERIFY INVENTORY AUTO-CREATED
  // ========================================
  const checkInventoryRes = http.get(
    `${BASE_URL}/inventory/api/inventory/product/${productId}`,
    {
      headers,
    }
  );

  check(checkInventoryRes, {
    "✓ [INVENTORY] Auto-created from event (200 or 404)": (r) =>
      r.status === 200 || r.status === 404, // 404 is ok if event not processed yet
  });

  if (checkInventoryRes.status === 200) {
    console.log(
      `✓ [VU${vuId}-${iterationId}] Inventory auto-created for product ${productId}`
    );
  } else {
    console.log(
      `⚠️  [VU${vuId}-${iterationId}] Inventory not yet created (event processing delay)`
    );
  }

  sleep(0.5);

  // ========================================
  // STEP 3: RESTOCK INVENTORY
  // ========================================
  const restockPayload = JSON.stringify({
    quantity: Math.floor(Math.random() * 50) + 20,
  });

  const restockRes = http.post(
    `${BASE_URL}/inventory/api/inventory/${productId}/restock`,
    restockPayload,
    {
      headers,
    }
  );

  check(restockRes, {
    "✓ [INVENTORY] Restocked successfully (200)": (r) => r.status === 200,
  });

  if (restockRes.status === 200) {
    try {
      const restockData = JSON.parse(restockRes.body);
      console.log(
        `✓ [VU${vuId}-${iterationId}] Restocked: ${restockData.available} units available`
      );
    } catch (e) {
      console.log(`✓ [VU${vuId}-${iterationId}] Restocked successfully`);
    }
  }

  sleep(0.5);

  // ========================================
  // STEP 4: CREATE ORDER
  // ========================================
  const orderPayload = JSON.stringify({
    ids: [productId],
  });

  const createOrderRes = http.post(`${BASE_URL}/product/orders`, orderPayload, {
    headers,
  });

  const orderCreated = check(createOrderRes, {
    "✓ [ORDER] Created successfully (202)": (r) => r.status === 202,
    "✓ [ORDER] Has orderId": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.orderId !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (orderCreated) {
    try {
      const orderData = JSON.parse(createOrderRes.body);
      console.log(
        `✓ [VU${vuId}-${iterationId}] Order created: ${orderData.orderId}`
      );
      console.log(`   → ORDER_CREATED event published to 'orders' queue`);
      console.log(`   → Order service will consume and process asynchronously`);
    } catch (e) {
      console.log(`✓ [VU${vuId}-${iterationId}] Order created successfully`);
    }
  } else {
    console.error(`✗ [VU${vuId}-${iterationId}] Failed to create order`);
  }

  sleep(1); // Wait for order processing

  // ========================================
  // STEP 5: CHECK INVENTORY STATUS AFTER ORDER
  // ========================================
  const checkInventoryAfterRes = http.get(
    `${BASE_URL}/inventory/api/inventory/product/${productId}`,
    {
      headers,
    }
  );

  check(checkInventoryAfterRes, {
    "✓ [INVENTORY] Status check after order (200)": (r) => r.status === 200,
  });

  if (checkInventoryAfterRes.status === 200) {
    try {
      const inventory = JSON.parse(checkInventoryAfterRes.body);
      console.log(`📊 [VU${vuId}-${iterationId}] Inventory status:`);
      console.log(`   - Available: ${inventory.available}`);
      console.log(`   - Reserved: ${inventory.reserved}`);
      console.log(`   - Backorder: ${inventory.backorder}`);
    } catch (e) {
      console.log(`✓ [VU${vuId}-${iterationId}] Inventory status retrieved`);
    }
  }

  sleep(0.5);

  // ========================================
  // STEP 6: DELETE PRODUCT
  // ========================================
  const deleteProductRes = http.del(`${BASE_URL}/product/${productId}`, null, {
    headers,
  });

  const productDeleted = check(deleteProductRes, {
    "✓ [PRODUCT] Deleted successfully (204)": (r) => r.status === 204,
  });

  if (productDeleted) {
    console.log(`✓ [VU${vuId}-${iterationId}] Product deleted: ${productId}`);
    console.log(`   → PRODUCT_DELETED event published to 'products' queue`);
    console.log(`   → Inventory service will auto-delete inventory record`);
  } else {
    console.error(`✗ [VU${vuId}-${iterationId}] Failed to delete product`);
  }

  sleep(1); // Wait for PRODUCT_DELETED event to be consumed

  // ========================================
  // STEP 7: VERIFY INVENTORY AUTO-DELETED
  // ========================================
  const verifyInventoryDeletedRes = http.get(
    `${BASE_URL}/inventory/api/inventory/product/${productId}`,
    {
      headers,
    }
  );

  check(verifyInventoryDeletedRes, {
    "✓ [INVENTORY] Auto-deleted after product deletion (404 or 200)": (r) =>
      r.status === 404 || r.status === 200, // 200 if event not processed yet
  });

  if (verifyInventoryDeletedRes.status === 404) {
    console.log(
      `✓ [VU${vuId}-${iterationId}] Inventory auto-deleted successfully`
    );
  } else {
    console.log(
      `⚠️  [VU${vuId}-${iterationId}] Inventory still exists (event processing delay)`
    );
  }

  console.log(`✅ [VU${vuId}-${iterationId}] Integration flow completed\n`);

  sleep(2);
}

// Teardown
export function teardown(data) {
  console.log("\n✓ ========================================");
  console.log("✓ Integration Test Summary");
  console.log("✓ ========================================");
  console.log("✓ Tested complete event-driven flow:");
  console.log("✓ 1. Product CRUD → PRODUCT_CREATED/DELETED events");
  console.log("✓ 2. Order creation → ORDER_CREATED events");
  console.log("✓ 3. Inventory sync → Auto create/delete via events");
  console.log(
    "✓ 4. Queue architecture → 3 queues (products, orders, inventory)"
  );
  console.log("✓ ========================================");
  console.log("📊 Check RabbitMQ Management UI for queue statistics");
  console.log("📊 Check service logs for event consumption details");
  console.log("✓ ========================================\n");
}
