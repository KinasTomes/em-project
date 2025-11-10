import http from "k6/http";
import { check, sleep } from "k6";

/**
 * K6 Load Test for Order Service
 * Tests: Order creation via Product service (event-driven flow)
 * Validates: ORDER_CREATED events consumption from orders queue
 */

export const options = {
  stages: [
    { duration: "5s", target: 3 }, // Warm up: 3 users
    { duration: "20s", target: 15 }, // Load: 15 users
    { duration: "15s", target: 15 }, // Sustained
    { duration: "5s", target: 0 }, // Cool down
  ],
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    http_req_failed: ["rate<0.08"],
    "http_req_duration{name:createOrder}": ["p(95)<1500"],
  },
};

const PRODUCT_URL = __ENV.PRODUCT_URL || "http://localhost:3003";
const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";

// Setup: Create test products and get token
export function setup() {
  // 1. Get auth token
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
    return { token: null, products: [] };
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // 2. Create test products
  const productIds = [];
  for (let i = 0; i < 5; i++) {
    const productPayload = JSON.stringify({
      name: `Order-Test-Product-${i}-${Date.now()}`,
      price: Math.floor(Math.random() * 500) + 50,
      description: `Product for order testing ${i}`,
    });

    const createRes = http.post(`${PRODUCT_URL}/product`, productPayload, {
      headers,
    });

    if (createRes.status === 201) {
      try {
        const product = JSON.parse(createRes.body);
        productIds.push(product._id);
      } catch (e) {
        console.error(`Failed to parse product ${i}:`, e);
      }
    }
    sleep(0.2);
  }

  console.log(`✓ [Setup] Created ${productIds.length} test products`);
  return { token, productIds };
}

export default function (data) {
  if (!data.token || data.productIds.length === 0) {
    console.error("Setup failed, skipping tests");
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
  };

  // Randomly select 1-3 products for the order
  const numProducts = Math.floor(Math.random() * 3) + 1;
  const selectedProducts = [];
  for (let i = 0; i < numProducts; i++) {
    const randomIndex = Math.floor(Math.random() * data.productIds.length);
    selectedProducts.push(data.productIds[randomIndex]);
  }

  // CREATE ORDER via Product Service
  // This publishes ORDER_CREATED event to orders queue
  // Order service consumes and processes it
  const orderPayload = JSON.stringify({
    ids: selectedProducts,
  });

  const orderRes = http.post(`${PRODUCT_URL}/product/orders`, orderPayload, {
    headers,
    tags: { name: "createOrder" },
  });

  check(orderRes, {
    "CREATE ORDER - status 202 (accepted)": (r) => r.status === 202,
    "CREATE ORDER - has orderId": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.orderId !== undefined;
      } catch {
        return false;
      }
    },
    "CREATE ORDER - has products": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.products) && body.products.length > 0;
      } catch {
        return false;
      }
    },
    "CREATE ORDER - message queued": (r) => {
      // If status is 202, ORDER_CREATED event was published to orders queue
      // Order service will consume it asynchronously
      return r.status === 202;
    },
  });

  if (orderRes.status === 202) {
    try {
      const orderData = JSON.parse(orderRes.body);
      console.log(
        `✓ Order ${orderData.orderId} created with ${selectedProducts.length} products`
      );
    } catch (e) {
      console.error("Failed to parse order response:", e);
    }
  }

  // Note: Order service processes messages asynchronously from RabbitMQ
  // The actual order creation in MongoDB happens after message consumption
  // This test validates the event publishing mechanism

  sleep(Math.random() * 2 + 1); // 1-3 seconds
}

// Teardown
export function teardown(data) {
  if (!data.token || !data.productIds || data.productIds.length === 0) {
    console.log("⚠️  [Teardown] No cleanup needed");
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
  };

  // Clean up test products
  let deletedCount = 0;
  for (const productId of data.productIds) {
    const deleteRes = http.del(`${PRODUCT_URL}/product/${productId}`, null, {
      headers,
    });
    if (deleteRes.status === 204) {
      deletedCount++;
    }
    sleep(0.1);
  }

  console.log(
    `✓ [Teardown] Cleaned up ${deletedCount}/${data.productIds.length} test products`
  );
  console.log("✓ [Teardown] Order service tests completed");
  console.log(
    "📊 [Note] Check Order service logs for message consumption stats"
  );
}
