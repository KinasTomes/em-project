/**
 * k6 Flash Sale Load Test
 * 
 * Chạy sau khi đã setup products và campaigns bằng setup.js
 * 
 * Usage:
 *   # Chạy setup trước
 *   node tests/flash-sale-simple/setup.js
 *   
 *   # Copy PRODUCT_IDS từ output, rồi chạy k6
 *   k6 run -e PRODUCT_IDS='["id1","id2","id3"]' tests/flash-sale-simple/load.test.js
 *   
 *   # Hoặc với custom config
 *   k6 run -e PRODUCT_IDS='["id1","id2"]' -e NUM_USERS=200 tests/flash-sale-simple/load.test.js
 * 
 * Environment:
 *   API_BASE     - API Gateway URL (default: http://localhost:3000)
 *   PRODUCT_IDS  - JSON array of product IDs (required)
 *   JWT_SECRET   - JWT secret (default: your-jwt-secret)
 *   NUM_USERS    - Concurrent users (default: 100)
 * 
 * Logic phân bổ users:
 *   - Users được chia đều vào các products theo round-robin
 *   - VU 1 → Product 1, VU 2 → Product 2, ..., VU N → Product (N % numProducts)
 *   - Mỗi user mua 1 lần, sau đó kiểm tra order status
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import encoding from 'k6/encoding';
import { hmac } from 'k6/crypto';

// ============================================
// CONFIG
// ============================================
const API_BASE = __ENV.API_BASE || 'http://35.213.165.98:3003';
const JWT_SECRET = __ENV.JWT_SECRET || '98w4jt9083w47t93w84tu3w094d8tw3j9o845t87j3w9od4857kw38457w39d458k7d3w94oo58k3w9045';
const NUM_USERS = parseInt(__ENV.NUM_USERS || '90');
// NOTE: CHECK_ORDER_STATUS is disabled by default because:
// - Seckill service returns a UUID orderId to client
// - But Order service creates order with MongoDB ObjectId (different ID)
// - So we cannot query order by the UUID returned from seckill
// To enable: set CHECK_ORDER_STATUS=true and implement order lookup by user
const CHECK_ORDER_STATUS = __ENV.CHECK_ORDER_STATUS === 'true'; // default false
const ORDER_STATUS_DELAY_MS = parseInt(__ENV.ORDER_STATUS_DELAY_MS || '2000'); // wait before checking order

// Parse product IDs from env
let PRODUCT_IDS = [];
try {
  PRODUCT_IDS = JSON.parse(__ENV.PRODUCT_IDS || '[]');
} catch (e) {
  console.error('❌ Invalid PRODUCT_IDS. Run setup.js first!');
}

// Calculate users per product for even distribution
const USERS_PER_PRODUCT = PRODUCT_IDS.length > 0 ? Math.ceil(NUM_USERS / PRODUCT_IDS.length) : 0;

// ============================================
// METRICS
// ============================================
const buySuccess = new Counter('buy_success');
const buyOutOfStock = new Counter('buy_out_of_stock');
const buyAlreadyPurchased = new Counter('buy_already_purchased');
const buyRateLimited = new Counter('buy_rate_limited');
const buyErrors = new Counter('buy_errors');
const buyLatency = new Trend('buy_latency', true);
const successRate = new Rate('success_rate');

// Order status metrics
const orderPaid = new Counter('order_paid');
const orderConfirmed = new Counter('order_confirmed');
const orderPending = new Counter('order_pending');
const orderCancelled = new Counter('order_cancelled');
const orderNotFound = new Counter('order_not_found');
const orderCheckLatency = new Trend('order_check_latency', true);

// ============================================
// OPTIONS
// ============================================
export const options = {
  scenarios: {
    flash_sale: {
      executor: 'per-vu-iterations',
      vus: NUM_USERS,
      iterations: 1,
      maxDuration: '120s', // increased for order status check
    },
  },
  thresholds: {
    'buy_latency': ['p(95)<500'],
    'buy_errors': ['count<10'],
  },
};


// ============================================
// JWT Helper (k6 compatible với k6/crypto)
// ============================================
function base64urlEncode(str) {
  // Encode string to base64url (no padding)
  const b64 = encoding.b64encode(str, 'std');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const message = `${headerB64}.${payloadB64}`;
  
  // HMAC-SHA256 signature
  const signatureBytes = hmac('sha256', secret, message, 'binary');
  const signatureB64 = encoding.b64encode(signatureBytes, 'rawstd')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  
  return `${message}.${signatureB64}`;
}

function generateToken(userId) {
  const payload = {
    id: userId,
    username: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  };
  return createJWT(payload, JWT_SECRET);
}

// ============================================
// MAIN TEST
// ============================================
export default function() {
  if (PRODUCT_IDS.length === 0) {
    console.error('❌ No PRODUCT_IDS! Run setup.js first.');
    return;
  }

  const vuId = __VU;
  const userId = `load-user-${vuId}-${Date.now()}`;
  const token = generateToken(userId);
  
  // Phân bổ users vào các products (round-robin đều)
  // VU 1,2,3 → Product 0; VU 4,5,6 → Product 1; etc.
  const productIndex = Math.floor((vuId - 1) / USERS_PER_PRODUCT) % PRODUCT_IDS.length;
  const productId = PRODUCT_IDS[productIndex];
  const userIndexInProduct = (vuId - 1) % USERS_PER_PRODUCT + 1;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // ========== STEP 1: BUY ==========
  const startTime = Date.now();
  const res = http.post(
    `${API_BASE}/seckill/buy`,
    JSON.stringify({ productId }),
    { headers, tags: { name: 'buy' } }
  );
  const latency = Date.now() - startTime;

  buyLatency.add(latency);

  let body = {};
  try {
    body = JSON.parse(res.body);
  } catch (e) {}

  let orderId = null;

  // Handle responses
  if (res.status === 202) {
    buySuccess.add(1);
    successRate.add(1);
    orderId = body.orderId;
    console.log(`✓ VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: SUCCESS orderId=${orderId} (${latency}ms)`);
  } else if (res.status === 409) {
    successRate.add(0);
    if (body.error === 'OUT_OF_STOCK') {
      buyOutOfStock.add(1);
      console.log(`✗ VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: OUT_OF_STOCK (${latency}ms)`);
    } else if (body.error === 'ALREADY_PURCHASED') {
      buyAlreadyPurchased.add(1);
      console.log(`✗ VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: ALREADY_PURCHASED (${latency}ms)`);
    }
  } else if (res.status === 429) {
    buyRateLimited.add(1);
    successRate.add(0);
    console.log(`⏳ VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: RATE_LIMITED (${latency}ms)`);
  } else if (res.status === 401) {
    buyErrors.add(1);
    successRate.add(0);
    console.log(`🔐 VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: UNAUTHORIZED (${latency}ms)`);
  } else {
    buyErrors.add(1);
    successRate.add(0);
    console.log(`❌ VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: ERROR ${res.status} - ${res.body} (${latency}ms)`);
  }

  check(res, {
    'valid response': (r) => [202, 400, 401, 409, 429].includes(r.status),
  });

  // ========== STEP 2: CHECK ORDER STATUS ==========
  if (CHECK_ORDER_STATUS && orderId) {
    // Wait for order processing (saga completion)
    sleep(ORDER_STATUS_DELAY_MS / 1000);

    const checkStart = Date.now();
    const orderRes = http.get(
      `${API_BASE}/orders/${orderId}`,
      { headers, tags: { name: 'check_order' } }
    );
    const checkLatency = Date.now() - checkStart;
    orderCheckLatency.add(checkLatency);

    let orderBody = {};
    try {
      orderBody = JSON.parse(orderRes.body);
    } catch (e) {}

    if (orderRes.status === 200) {
      const status = orderBody.status || orderBody.order?.status;
      
      if (status === 'PAID') {
        orderPaid.add(1);
        console.log(`  📦 VU${vuId}: Order ${orderId} → PAID ✓ (${checkLatency}ms)`);
      } else if (status === 'CONFIRMED') {
        orderConfirmed.add(1);
        console.log(`  📦 VU${vuId}: Order ${orderId} → CONFIRMED (${checkLatency}ms)`);
      } else if (status === 'PENDING') {
        orderPending.add(1);
        console.log(`  📦 VU${vuId}: Order ${orderId} → PENDING (${checkLatency}ms)`);
      } else if (status === 'CANCELLED') {
        orderCancelled.add(1);
        const reason = orderBody.cancellationReason || orderBody.order?.cancellationReason || 'unknown';
        console.log(`  📦 VU${vuId}: Order ${orderId} → CANCELLED (${reason}) (${checkLatency}ms)`);
      } else {
        console.log(`  📦 VU${vuId}: Order ${orderId} → ${status} (${checkLatency}ms)`);
      }

      check(orderRes, {
        'order has valid status': () => ['PENDING', 'CONFIRMED', 'PAID', 'CANCELLED'].includes(status),
      });
    } else if (orderRes.status === 404) {
      orderNotFound.add(1);
      console.log(`  ⚠️ VU${vuId}: Order ${orderId} NOT FOUND (${checkLatency}ms)`);
    } else {
      console.log(`  ❌ VU${vuId}: Order check failed ${orderRes.status} (${checkLatency}ms)`);
    }
  }
}

// ============================================
// SETUP & TEARDOWN
// ============================================
export function setup() {
  console.log('='.repeat(60));
  console.log('🎯 k6 FLASH SALE LOAD TEST');
  console.log('='.repeat(60));
  console.log(`API: ${API_BASE}`);
  console.log(`Total Users: ${NUM_USERS}`);
  console.log(`Products: ${PRODUCT_IDS.length}`);
  console.log(`Users per Product: ~${USERS_PER_PRODUCT}`);
  console.log(`Check Order Status: ${CHECK_ORDER_STATUS}`);
  console.log(`Order Status Delay: ${ORDER_STATUS_DELAY_MS}ms`);
  console.log('='.repeat(60));

  if (PRODUCT_IDS.length === 0) {
    console.error('\n❌ ERROR: No PRODUCT_IDS provided!');
    console.error('Run setup.js first:');
    console.error('  node tests/flash-sale-simple/setup.js');
    console.error('\nThen copy PRODUCT_IDS to k6 command.');
    return { productIds: [], initialStock: {} };
  }

  // Verify campaigns exist and store initial stock
  const initialStock = {};
  console.log('\n📦 PRODUCT DISTRIBUTION:');
  
  for (let i = 0; i < PRODUCT_IDS.length; i++) {
    const productId = PRODUCT_IDS[i];
    const res = http.get(`${API_BASE}/seckill/status/${productId}`);
    
    // Calculate which VUs will target this product
    const startVU = i * USERS_PER_PRODUCT + 1;
    const endVU = Math.min((i + 1) * USERS_PER_PRODUCT, NUM_USERS);
    const assignedUsers = endVU - startVU + 1;
    
    if (res.status === 200) {
      const status = JSON.parse(res.body);
      initialStock[productId] = status.totalStock;
      
      console.log(`\n  Product ${i + 1}: ${productId}`);
      console.log(`    Stock: ${status.stockRemaining}/${status.totalStock}`);
      console.log(`    Active: ${status.isActive}`);
      console.log(`    Assigned VUs: ${startVU}-${endVU} (${assignedUsers} users)`);
      
      if (assignedUsers > status.stockRemaining) {
        console.log(`    ⚠️  More users (${assignedUsers}) than stock (${status.stockRemaining})`);
      }
    } else {
      console.log(`\n  ⚠️  Product ${i + 1}: Campaign not found!`);
      console.log(`    Assigned VUs: ${startVU}-${endVU} (${assignedUsers} users)`);
    }
  }

  console.log('\n' + '='.repeat(60));
  return { productIds: PRODUCT_IDS, initialStock };
}

export function teardown(data) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 FINAL RESULTS');
  console.log('='.repeat(60));

  let totalSold = 0;
  let totalStock = 0;
  let hasOverselling = false;

  // Check final status for each product
  for (let i = 0; i < data.productIds.length; i++) {
    const productId = data.productIds[i];
    const res = http.get(`${API_BASE}/seckill/status/${productId}`);
    
    if (res.status === 200) {
      const status = JSON.parse(res.body);
      const initialStockValue = data.initialStock[productId] || status.totalStock;
      const sold = initialStockValue - status.stockRemaining;
      
      totalSold += sold;
      totalStock += initialStockValue;
      
      console.log(`\n  Product ${i + 1}: ${productId}`);
      console.log(`    Initial Stock: ${initialStockValue}`);
      console.log(`    Remaining: ${status.stockRemaining}`);
      console.log(`    Sold: ${sold}`);
      
      if (status.stockRemaining < 0) {
        console.log(`    ❌ OVERSELLING DETECTED! (${Math.abs(status.stockRemaining)} oversold)`);
        hasOverselling = true;
      } else if (status.stockRemaining === 0) {
        console.log(`    ✓ All sold out`);
      } else {
        console.log(`    ○ ${status.stockRemaining} remaining`);
      }
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log('📈 SUMMARY:');
  console.log(`  Total Stock: ${totalStock}`);
  console.log(`  Total Sold: ${totalSold}`);
  console.log(`  Total Users: ${NUM_USERS}`);
  
  if (hasOverselling) {
    console.log('\n  ❌ TEST FAILED: Overselling detected!');
  } else {
    console.log('\n  ✅ TEST PASSED: No overselling');
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Test completed!');
  console.log('='.repeat(60));
}
