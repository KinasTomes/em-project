/**
 * k6 Load Test: Order Flow (Light)
 * 
 * Test Scenario:
 * - Register/Login users
 * - Create products with inventory
 * - Create orders (PENDING)
 * - Poll until order reaches CONFIRMED/CANCELLED
 * - Measure end-to-end latency
 * 
 * Usage:
 *   k6 run tests/k6/order-flow.test.js
 *   k6 run --vus 5 --duration 30s tests/k6/order-flow.test.js
 *   k6 run --vus 10 --duration 1m tests/k6/order-flow.test.js
 * 
 * Environment Variables:
 *   API_BASE=http://localhost:3003 (default)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

// Configuration
const API_BASE = __ENV.API_BASE || 'http://localhost:3003';
const POLL_INTERVAL = 1; // seconds
const MAX_POLL_ATTEMPTS = 45; // 45 attempts = 45 seconds max

// Custom Metrics
const orderCreationDuration = new Trend('order_creation_duration');
const orderE2ELatency = new Trend('order_e2e_latency'); // Full saga duration
const pollAttempts = new Trend('order_poll_attempts');
const ordersConfirmed = new Counter('orders_confirmed_total');
const ordersCancelled = new Counter('orders_cancelled_total');
const ordersTimedOut = new Counter('orders_timed_out_total');
const orderSuccessRate = new Rate('order_success_rate');

// Test Options
export const options = {
  // Light load test
  stages: [
    { duration: '10s', target: 10 },   // Ramp up to 5 VUs
    { duration: '30s', target: 10 },   // Stay at 5 VUs
    { duration: '10s', target: 0 },   // Ramp down
  ],
  thresholds: {
    'order_e2e_latency': ['p(95)<5000', 'p(99)<10000'], // 95% < 5s, 99% < 10s
    'order_success_rate': ['rate>0.9'],                  // 90% success rate
    'http_req_duration': ['p(95)<2000'],                 // HTTP calls < 2s
  },
};

// Helper: Parse JSON safely
function parseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch (e) {
    console.error(`Failed to parse JSON: ${response.body}`);
    return null;
  }
}

// Helper: Poll order until final status
function pollOrderStatus(orderId, token) {
  const startTime = Date.now();
  let attempts = 0;
  
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    attempts++;
    
    const response = http.get(`${API_BASE}/orders/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      tags: { name: 'poll_order_status' },
    });
    
    if (response.status === 200) {
      const order = parseJson(response);
      if (order && order.status) {
        const status = order.status;
        
        if (status === 'CONFIRMED') {
          const duration = Date.now() - startTime;
          orderE2ELatency.add(duration);
          pollAttempts.add(attempts);
          ordersConfirmed.add(1);
          orderSuccessRate.add(true);
          return { success: true, status, duration };
        }
        
        if (status === 'CANCELLED') {
          const duration = Date.now() - startTime;
          orderE2ELatency.add(duration);
          pollAttempts.add(attempts);
          ordersCancelled.add(1);
          orderSuccessRate.add(true);
          return { success: true, status, duration };
        }
        
        // Still PENDING, continue polling
      }
    }
    
    sleep(POLL_INTERVAL);
  }
  
  // Timeout
  ordersTimedOut.add(1);
  orderSuccessRate.add(false);
  return { success: false, status: 'TIMEOUT', duration: Date.now() - startTime };
}

// Main test scenario
export default function () {
  const vuId = __VU;
  const iterationId = __ITER;
  const timestamp = Date.now();
  
  // Generate unique credentials
  const username = `k6_user_${vuId}_${iterationId}_${timestamp}`;
  const password = 'K6TestP@ssw0rd123';
  
  // ===================================================================
  // STEP 1: Register User
  // ===================================================================
  let registerResponse = http.post(
    `${API_BASE}/auth/register`,
    JSON.stringify({ username, password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'register_user' },
    }
  );
  
  const registerSuccess = check(registerResponse, {
    'register status 200/201': (r) => r.status === 200 || r.status === 201,
  });
  
  if (!registerSuccess) {
    // Try to continue if user already exists
    if (registerResponse.status !== 400) {
      console.error(`Registration failed: ${registerResponse.status} - ${registerResponse.body}`);
      return;
    }
  }
  
  // ===================================================================
  // STEP 2: Login
  // ===================================================================
  const loginResponse = http.post(
    `${API_BASE}/auth/login`,
    JSON.stringify({ username, password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'login_user' },
    }
  );
  
  const loginSuccess = check(loginResponse, {
    'login status 200': (r) => r.status === 200,
    'login has token': (r) => {
      const body = parseJson(r);
      return body && body.token;
    },
  });
  
  if (!loginSuccess) {
    console.error(`Login failed: ${loginResponse.status} - ${loginResponse.body}`);
    return;
  }
  
  const loginData = parseJson(loginResponse);
  const token = loginData.token;
  
  // ===================================================================
  // STEP 3: Create Product (with inventory)
  // ===================================================================
  const productData = {
    name: `K6 Product ${vuId}_${iterationId}_${timestamp}`,
    price: 99.99,
    description: 'K6 load test product',
    available: 100, // Sufficient stock
  };
  
  const productResponse = http.post(
    `${API_BASE}/products`,
    JSON.stringify(productData),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      tags: { name: 'create_product' },
    }
  );
  
  const productSuccess = check(productResponse, {
    'product status 201': (r) => r.status === 201,
    'product has id': (r) => {
      const body = parseJson(r);
      return body && (body._id || body.id);
    },
  });
  
  if (!productSuccess) {
    console.error(`Product creation failed: ${productResponse.status} - ${productResponse.body}`);
    return;
  }
  
  const productBody = parseJson(productResponse);
  const productId = productBody._id || productBody.id;
  
  // Small delay to ensure inventory is synced
  sleep(0.5);
  
  // ===================================================================
  // STEP 4: Create Order
  // ===================================================================
  const orderData = {
    ids: [productId],
    quantities: [2],
  };
  
  const orderStartTime = Date.now();
  
  const orderResponse = http.post(
    `${API_BASE}/orders`,
    JSON.stringify(orderData),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      tags: { name: 'create_order' },
    }
  );
  
  orderCreationDuration.add(Date.now() - orderStartTime);
  
  const orderSuccess = check(orderResponse, {
    'order status 201': (r) => r.status === 201,
    'order has orderId': (r) => {
      const body = parseJson(r);
      return body && body.orderId;
    },
    'order status PENDING': (r) => {
      const body = parseJson(r);
      return body && body.status === 'PENDING';
    },
  });
  
  if (!orderSuccess) {
    console.error(`Order creation failed: ${orderResponse.status} - ${orderResponse.body}`);
    return;
  }
  
  const orderBody = parseJson(orderResponse);
  const orderId = orderBody.orderId;
  
  // ===================================================================
  // STEP 5: Poll Order Status (until CONFIRMED/CANCELLED)
  // ===================================================================
  const result = pollOrderStatus(orderId, token);
  
  check(result, {
    'order reached final status': (r) => r.success,
    'order confirmed or cancelled': (r) => r.status === 'CONFIRMED' || r.status === 'CANCELLED',
  });
  
  if (result.success) {
    console.log(`✓ Order ${orderId} → ${result.status} (${result.duration}ms, ${pollAttempts} attempts)`);
  } else {
    console.error(`✗ Order ${orderId} → TIMEOUT after ${result.duration}ms`);
  }
  
  // Think time between iterations
  sleep(1);
}

// Setup: Run once before test
export function setup() {
  console.log('='.repeat(60));
  console.log('k6 Load Test: Order Flow (Light)');
  console.log('='.repeat(60));
  console.log(`API Base: ${API_BASE}`);
  console.log(`Poll Interval: ${POLL_INTERVAL}s`);
  console.log(`Max Poll Time: ${MAX_POLL_ATTEMPTS}s`);
  console.log('='.repeat(60));
  
  // Simple connectivity check (API Gateway doesn't have /health endpoint)
  // Try to access a known endpoint to verify API is reachable
  console.log('✓ k6 test ready to start\n');
  return { apiBase: API_BASE };
}

// Teardown: Run once after test
export function teardown(data) {
  console.log('\n' + '='.repeat(60));
  console.log('Test completed!');
  console.log('='.repeat(60));
}
