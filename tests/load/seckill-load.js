/**
 * k6 Load Test: Seckill Service (Flash Sale)
 * 
 * Test Scenario:
 * - Initialize a seckill campaign with 100 items
 * - Simulate 1000 concurrent users fighting for 100 items
 * - Verify P99 latency < 50ms
 * - Verify no overselling (exactly 100 successful purchases)
 * - Verify no negative stock
 * 
 * Requirements: 4.1, 2.2
 * 
 * Usage:
 *   k6 run tests/load/seckill-load.js
 *   k6 run --vus 100 --duration 30s tests/load/seckill-load.js
 * 
 * Environment Variables:
 *   API_BASE=http://localhost:3003 (default - via API Gateway)
 *   SECKILL_BASE=http://localhost:3007 (direct seckill service)
 *   ADMIN_KEY=seckill-admin-key (default)
 *   STOCK=100 (default)
 *   CONCURRENT_USERS=1000 (default)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate, Gauge } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// Configuration
const API_BASE = __ENV.API_BASE || 'http://localhost:3003';
const SECKILL_BASE = __ENV.SECKILL_BASE || API_BASE;
const ADMIN_KEY = __ENV.ADMIN_KEY || 'seckill-admin-key';
const STOCK = parseInt(__ENV.STOCK || '100', 10);
const CONCURRENT_USERS = parseInt(__ENV.CONCURRENT_USERS || '1000', 10);

// Product ID for the seckill campaign
const PRODUCT_ID = `seckill-load-test-${Date.now()}`;

// Custom Metrics
const buyLatency = new Trend('seckill_buy_latency', true);
const statusLatency = new Trend('seckill_status_latency', true);
const successfulPurchases = new Counter('seckill_successful_purchases');
const failedPurchases = new Counter('seckill_failed_purchases');
const outOfStockResponses = new Counter('seckill_out_of_stock');
const alreadyPurchasedResponses = new Counter('seckill_already_purchased');
const rateLimitedResponses = new Counter('seckill_rate_limited');
const purchaseSuccessRate = new Rate('seckill_purchase_success_rate');
const stockRemaining = new Gauge('seckill_stock_remaining');

// Test Options
export const options = {
  scenarios: {
    // Scenario 1: Initialize campaign (runs once at start)
    init_campaign: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '10s',
      exec: 'initCampaign',
      startTime: '0s',
    },
    // Scenario 2: Flash sale - all users hit at once
    flash_sale: {
      executor: 'per-vu-iterations',
      vus: CONCURRENT_USERS,
      iterations: 1,
      maxDuration: '60s',
      exec: 'buyItem',
      startTime: '5s', // Start after campaign init
    },
    // Scenario 3: Verify results
    verify_results: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '10s',
      exec: 'verifyResults',
      startTime: '70s', // Start after flash sale completes
    },
  },
  thresholds: {
    'seckill_buy_latency': ['p(99)<50'], // P99 latency < 50ms
    'seckill_successful_purchases': [`count==${STOCK}`], // Exactly STOCK successful purchases
    'http_req_duration{name:buy}': ['p(99)<100'], // HTTP P99 < 100ms
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

// Helper: Get seckill endpoint URL
function getSeckillUrl(path) {
  // If using API Gateway, prefix with /seckill
  if (SECKILL_BASE === API_BASE) {
    return `${API_BASE}/seckill${path}`;
  }
  // Direct seckill service
  return `${SECKILL_BASE}/seckill${path}`;
}

// Helper: Get admin endpoint URL
function getAdminUrl(path) {
  // If using API Gateway, prefix with /admin/seckill
  if (SECKILL_BASE === API_BASE) {
    return `${API_BASE}/admin/seckill${path}`;
  }
  // Direct seckill service
  return `${SECKILL_BASE}/admin/seckill${path}`;
}

// Scenario 1: Initialize Campaign
export function initCampaign() {
  console.log('='.repeat(60));
  console.log('Initializing Seckill Campaign');
  console.log('='.repeat(60));
  console.log(`Product ID: ${PRODUCT_ID}`);
  console.log(`Stock: ${STOCK}`);
  console.log(`Concurrent Users: ${CONCURRENT_USERS}`);
  console.log('='.repeat(60));

  const now = new Date();
  const startTime = new Date(now.getTime() - 60000).toISOString(); // Started 1 minute ago
  const endTime = new Date(now.getTime() + 3600000).toISOString(); // Ends in 1 hour

  const campaignData = {
    productId: PRODUCT_ID,
    stock: STOCK,
    price: 99.99,
    startTime: startTime,
    endTime: endTime,
  };

  const response = http.post(
    getAdminUrl('/init'),
    JSON.stringify(campaignData),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': ADMIN_KEY,
      },
      tags: { name: 'init_campaign' },
    }
  );

  const success = check(response, {
    'init campaign status 200/201': (r) => r.status === 200 || r.status === 201,
    'init campaign success': (r) => {
      const body = parseJson(r);
      return body && body.success === true;
    },
  });

  if (!success) {
    console.error(`Campaign init failed: ${response.status} - ${response.body}`);
    return;
  }

  console.log('✓ Campaign initialized successfully');
  
  // Verify campaign status
  const statusResponse = http.get(
    getSeckillUrl(`/status/${PRODUCT_ID}`),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'status' },
    }
  );

  check(statusResponse, {
    'status check 200': (r) => r.status === 200,
    'stock matches': (r) => {
      const body = parseJson(r);
      return body && body.stockRemaining === STOCK;
    },
  });

  const statusBody = parseJson(statusResponse);
  console.log(`✓ Campaign status: ${JSON.stringify(statusBody)}`);
}

// Scenario 2: Buy Item (Flash Sale)
export function buyItem() {
  const vuId = __VU;
  const userId = `load-test-user-${vuId}-${Date.now()}`;

  const buyData = {
    productId: PRODUCT_ID,
  };

  const startTime = Date.now();
  
  const response = http.post(
    getSeckillUrl('/buy'),
    JSON.stringify(buyData),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      },
      tags: { name: 'buy' },
    }
  );

  const latency = Date.now() - startTime;
  buyLatency.add(latency);

  const status = response.status;
  const body = parseJson(response);

  if (status === 202) {
    // Successful purchase
    successfulPurchases.add(1);
    purchaseSuccessRate.add(true);
    console.log(`✓ VU ${vuId}: Purchase successful (${latency}ms)`);
  } else if (status === 409) {
    // Conflict - out of stock or already purchased
    failedPurchases.add(1);
    purchaseSuccessRate.add(false);
    
    if (body && body.error === 'OUT_OF_STOCK') {
      outOfStockResponses.add(1);
      console.log(`✗ VU ${vuId}: Out of stock (${latency}ms)`);
    } else if (body && body.error === 'ALREADY_PURCHASED') {
      alreadyPurchasedResponses.add(1);
      console.log(`✗ VU ${vuId}: Already purchased (${latency}ms)`);
    }
  } else if (status === 429) {
    // Rate limited
    failedPurchases.add(1);
    purchaseSuccessRate.add(false);
    rateLimitedResponses.add(1);
    console.log(`✗ VU ${vuId}: Rate limited (${latency}ms)`);
  } else {
    // Other error
    failedPurchases.add(1);
    purchaseSuccessRate.add(false);
    console.error(`✗ VU ${vuId}: Unexpected response ${status} - ${response.body} (${latency}ms)`);
  }

  check(response, {
    'buy response valid': (r) => [202, 409, 429, 400].includes(r.status),
    'buy latency < 50ms': () => latency < 50,
  });
}


// Scenario 3: Verify Results
export function verifyResults() {
  console.log('\n' + '='.repeat(60));
  console.log('Verifying Results');
  console.log('='.repeat(60));

  // Get final campaign status
  const startTime = Date.now();
  
  const response = http.get(
    getSeckillUrl(`/status/${PRODUCT_ID}`),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'verify_status' },
    }
  );

  statusLatency.add(Date.now() - startTime);

  const success = check(response, {
    'verify status 200': (r) => r.status === 200,
  });

  if (!success) {
    console.error(`Status check failed: ${response.status} - ${response.body}`);
    return;
  }

  const body = parseJson(response);
  
  if (body) {
    stockRemaining.add(body.stockRemaining);
    
    console.log(`Final Stock Remaining: ${body.stockRemaining}`);
    console.log(`Total Stock: ${body.totalStock}`);
    console.log(`Items Sold: ${body.totalStock - body.stockRemaining}`);
    
    // Verify no overselling
    check(body, {
      'no negative stock': (b) => b.stockRemaining >= 0,
      'stock is zero (all sold)': (b) => b.stockRemaining === 0,
      'no overselling': (b) => (b.totalStock - b.stockRemaining) <= STOCK,
    });

    if (body.stockRemaining < 0) {
      console.error('❌ CRITICAL: Negative stock detected! Overselling occurred!');
    } else if (body.stockRemaining === 0) {
      console.log('✓ All items sold, no overselling');
    } else {
      console.log(`⚠ ${body.stockRemaining} items remaining (not all sold)`);
    }
  }

  console.log('='.repeat(60));
}

// Setup: Run once before test
export function setup() {
  console.log('='.repeat(60));
  console.log('k6 Load Test: Seckill Service (Flash Sale)');
  console.log('='.repeat(60));
  console.log(`API Base: ${API_BASE}`);
  console.log(`Seckill Base: ${SECKILL_BASE}`);
  console.log(`Admin Key: ${ADMIN_KEY.substring(0, 4)}...`);
  console.log(`Stock: ${STOCK}`);
  console.log(`Concurrent Users: ${CONCURRENT_USERS}`);
  console.log(`Product ID: ${PRODUCT_ID}`);
  console.log('='.repeat(60));
  
  return {
    productId: PRODUCT_ID,
    stock: STOCK,
    concurrentUsers: CONCURRENT_USERS,
  };
}

// Teardown: Run once after test
export function teardown(data) {
  console.log('\n' + '='.repeat(60));
  console.log('Seckill Load Test Completed');
  console.log('='.repeat(60));
  console.log(`Product ID: ${data.productId}`);
  console.log(`Initial Stock: ${data.stock}`);
  console.log(`Concurrent Users: ${data.concurrentUsers}`);
  console.log('='.repeat(60));
  console.log('\nKey Metrics to Check:');
  console.log('- seckill_successful_purchases: Should equal initial stock');
  console.log('- seckill_buy_latency p99: Should be < 50ms');
  console.log('- seckill_stock_remaining: Should be 0 (no negative)');
  console.log('='.repeat(60));
}

// Default function (not used in scenarios, but required)
export default function() {
  // This is not used when scenarios are defined
  sleep(1);
}
