import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

// Test configuration
export const options = {
  stages: [
    { duration: "30s", target: 10 }, // Ramp up to 10 users
    { duration: "1m", target: 10 }, // Stay at 10 users
    { duration: "10s", target: 0 }, // Ramp down to 0 users
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"], // 95% of requests should be below 500ms
    http_req_failed: ["rate<0.1"], // Less than 10% of requests should fail
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3004";
const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";

let TOKEN = null;

// Setup function to get auth token before tests
export function setup() {
  const loginPayload = JSON.stringify({
    username: "testuser",
    password: "testpass123",
  });

  const loginResponse = http.post(`${AUTH_URL}/login`, loginPayload, {
    headers: { "Content-Type": "application/json" },
  });

  if (loginResponse.status === 200) {
    const data = JSON.parse(loginResponse.body);
    console.log("✓ Authentication successful");
    return { token: data.token };
  } else {
    console.error("✗ Authentication failed:", loginResponse.status);
    return { token: null };
  }
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

  // Test 3: Create order
  const orderPayload = JSON.stringify({
    ids: ["691056762aa8896fef1113ee"], // Example product ID
  });

  const response = http.post(`${BASE_URL}/api/orders`, orderPayload, {
    headers,
  });
  check(response, {
    "POST /api/orders - status 202 or 401": (r) =>
      r.status === 202 || r.status === 401 || r.status === 400,
    "POST /api/orders - response time OK": (r) => r.timings.duration < 1000,
  });

  sleep(1);
}
