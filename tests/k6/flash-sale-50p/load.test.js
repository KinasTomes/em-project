/**
 * k6 Flash Sale Load Test - 50 Products x 50 Stock x 2500 Users
 * 
 * Kịch bản:
 * - 50 sản phẩm, mỗi sản phẩm stock = 50
 * - 2500 users đồng thời (50 users per product)
 * - Mỗi product có 50 users, 50 stock → 100% success rate
 * - Users được phân bổ đều: VU 1-50 → Product 1, VU 51-100 → Product 2, ...
 * 
 * Usage:
 *   # Chạy setup trước
 *   node tests/k6/flash-sale-50p/setup.js
 *   
 *   # Chạy k6 test (tự động đọc product-ids.json)
 *   k6 run tests/k6/flash-sale-50p/load.test.js
 *   
 *   # Hoặc với custom config
 *   k6 run -e PRODUCT_IDS='["id1","id2",...]' -e NUM_USERS=2500 tests/k6/flash-sale-50p/load.test.js
 * 
 * Expected Results:
 *   - Total success: ~2500 (100%)
 *   - Total OUT_OF_STOCK: 0 (0%)
 *   - No overselling (stock không âm)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import encoding from 'k6/encoding';
import { hmac } from 'k6/crypto';
import { SharedArray } from 'k6/data';

// ============================================
// CONFIG
// ============================================
const API_BASE = __ENV.API_BASE || 'http://35.213.165.98:3003';
const JWT_SECRET = __ENV.JWT_SECRET || '98w4jt9083w47t93w84tu3w094d8tw3j9o845t87j3w9od4857kw38457w39d458k7d3w94oo58k3w9045';
const NUM_USERS = parseInt(__ENV.NUM_USERS || '2500');
const NUM_PRODUCTS = parseInt(__ENV.NUM_PRODUCTS || '50');
const STOCK_PER_PRODUCT = parseInt(__ENV.STOCK_PER_PRODUCT || '50');
const USERS_PER_PRODUCT = parseInt(__ENV.USERS_PER_PRODUCT || '50');

// Ramp-up config
const RAMP_UP_TIME = __ENV.RAMP_UP_TIME || '30s';
const HOLD_TIME = __ENV.HOLD_TIME || '60s';
const RAMP_DOWN_TIME = __ENV.RAMP_DOWN_TIME || '10s';

// Parse product IDs
let PRODUCT_IDS = [];
try {
  if (__ENV.PRODUCT_IDS) {
    PRODUCT_IDS = JSON.parse(__ENV.PRODUCT_IDS);
  }
} catch (e) {
  console.error('❌ Invalid PRODUCT_IDS format');
}

// Try to load from file if not provided via env
const productIdsFromFile = new SharedArray('productIds', function() {
  try {
    // k6 runs from workspace root, so path is relative to that
    console.log("Reading product-ids.json...");
    const data = open('./product-ids.json');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
});

if (PRODUCT_IDS.length === 0 && productIdsFromFile.length > 0) {
  PRODUCT_IDS = productIdsFromFile;
}

// ============================================
// METRICS
// ============================================
// Buy metrics
const buySuccess = new Counter('buy_success');
const buyOutOfStock = new Counter('buy_out_of_stock');
const buyAlreadyPurchased = new Counter('buy_already_purchased');
const buyRateLimited = new Counter('buy_rate_limited');
const buyErrors = new Counter('buy_errors');
const buyLatency = new Trend('buy_latency', true);
const successRate = new Rate('success_rate');

// Per-product metrics (for debugging)
const productSuccessCounters = {};
const productFailCounters = {};

// ============================================
// OPTIONS - Burst mode (mỗi user mua 1 lần)
// ============================================
export const options = {
  scenarios: {
    flash_sale_burst: {
      executor: 'per-vu-iterations',
      vus: NUM_USERS,
      iterations: 1,
      maxDuration: '120s',
    },
  },
  thresholds: {
    'buy_latency': ['p(95)<3000', 'p(99)<10000'],
    'buy_errors': ['rate<0.1'],
    'http_req_failed': ['rate<0.1'],
  },
};

// ============================================
// JWT Helper (k6 compatible)
// ============================================
function base64urlEncode(str) {
  const b64 = encoding.b64encode(str, 'std');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const message = `${headerB64}.${payloadB64}`;
  
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
    exp: Math.floor(Date.now() / 1000) + 3600,
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
  const userId = `k6-user-${vuId}`;
  const token = generateToken(userId);
  
  // Phân bổ users vào products
  // VU 1-100 → Product 0, VU 101-200 → Product 1, ...
  const productIndex = Math.floor((vuId - 1) / USERS_PER_PRODUCT) % PRODUCT_IDS.length;
  const productId = PRODUCT_IDS[productIndex];
  const userIndexInProduct = ((vuId - 1) % USERS_PER_PRODUCT) + 1;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // Random delay để tránh thundering herd (0-1000ms)
  sleep(Math.random() * 1);

  // ========== BUY REQUEST ==========
  const startTime = Date.now();
  const res = http.post(
    `${API_BASE}/seckill/buy`,
    JSON.stringify({ productId }),
    { headers, tags: { name: 'seckill_buy', product: `p${productIndex + 1}` } }
  );
  const latency = Date.now() - startTime;

  buyLatency.add(latency);

  let body = {};
  try {
    body = JSON.parse(res.body);
  } catch (e) {}

  // Handle responses
  if (res.status === 202) {
    buySuccess.add(1);
    successRate.add(1);
    
    // Log mỗi 100 success để theo dõi
    if (vuId % 100 === 1) {
      console.log(`✓ VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: SUCCESS (${latency}ms)`);
    }
  } else if (res.status === 409) {
    successRate.add(0);
    
    if (body.error === 'OUT_OF_STOCK') {
      buyOutOfStock.add(1);
      // Log mỗi 100 out_of_stock
      if (vuId % 100 === 1) {
        console.log(`✗ VU${vuId} [P${productIndex + 1}:U${userIndexInProduct}]: OUT_OF_STOCK (${latency}ms)`);
      }
    } else if (body.error === 'ALREADY_PURCHASED') {
      buyAlreadyPurchased.add(1);
      console.log(`⚠ VU${vuId} [P${productIndex + 1}]: ALREADY_PURCHASED (${latency}ms)`);
    } else {
      buyErrors.add(1);
      console.log(`❌ VU${vuId} [P${productIndex + 1}]: 409 - ${body.error} (${latency}ms)`);
    }
  } else if (res.status === 429) {
    buyRateLimited.add(1);
    successRate.add(0);
    console.log(`⏳ VU${vuId} [P${productIndex + 1}]: RATE_LIMITED (${latency}ms)`);
  } else if (res.status === 401) {
    buyErrors.add(1);
    successRate.add(0);
    console.log(`🔐 VU${vuId} [P${productIndex + 1}]: UNAUTHORIZED (${latency}ms)`);
  } else {
    buyErrors.add(1);
    successRate.add(0);
    console.log(`❌ VU${vuId} [P${productIndex + 1}]: ERROR ${res.status} - ${res.body?.substring(0, 100)} (${latency}ms)`);
  }

  check(res, {
    'valid response': (r) => [202, 400, 401, 409, 429].includes(r.status),
    'not server error': (r) => r.status < 500,
  });
}

// ============================================
// SETUP
// ============================================
export function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('🎯 k6 FLASH SALE LOAD TEST - 50 Products x 50 Stock x 2500 Users');
  console.log('='.repeat(70));
  console.log(`API: ${API_BASE}`);
  console.log(`Total Users: ${NUM_USERS}`);
  console.log(`Products: ${PRODUCT_IDS.length}`);
  console.log(`Stock per Product: ${STOCK_PER_PRODUCT}`);
  console.log(`Users per Product: ${USERS_PER_PRODUCT}`);
  console.log(`Expected Success Rate: 100% (${USERS_PER_PRODUCT} users = ${STOCK_PER_PRODUCT} stock)`);
  console.log('='.repeat(70));

  if (PRODUCT_IDS.length === 0) {
    console.error('\n❌ ERROR: No PRODUCT_IDS provided!');
    console.error('Run setup.js first:');
    console.error('  node tests/k6/flash-sale-50p/setup.js');
    return { productIds: [], initialStock: {} };
  }

  // Verify campaigns and store initial stock
  const initialStock = {};
  let totalStock = 0;
  let activeProducts = 0;

  console.log('\n📦 Verifying campaigns...');
  
  // Check first 5 and last 5 products
  const checkIndices = [
    ...Array.from({ length: Math.min(5, PRODUCT_IDS.length) }, (_, i) => i),
    ...Array.from({ length: Math.min(5, PRODUCT_IDS.length) }, (_, i) => PRODUCT_IDS.length - 5 + i).filter(i => i >= 5)
  ];

  for (const i of checkIndices) {
    const productId = PRODUCT_IDS[i];
    const res = http.get(`${API_BASE}/seckill/status/${productId}`);
    
    if (res.status === 200) {
      const status = JSON.parse(res.body);
      initialStock[productId] = status.totalStock;
      totalStock += status.totalStock;
      activeProducts++;
      
      console.log(`  Product ${i + 1}: stock=${status.stockRemaining}/${status.totalStock}, active=${status.isActive}`);
    } else {
      console.log(`  ⚠️ Product ${i + 1}: Campaign not found!`);
    }
  }

  if (PRODUCT_IDS.length > 10) {
    console.log(`  ... and ${PRODUCT_IDS.length - 10} more products`);
  }

  // Estimate total stock
  const estimatedTotalStock = PRODUCT_IDS.length * STOCK_PER_PRODUCT;
  
  console.log('\n📊 TEST PARAMETERS:');
  console.log(`  Total Products: ${PRODUCT_IDS.length}`);
  console.log(`  Estimated Total Stock: ${estimatedTotalStock}`);
  console.log(`  Total Users: ${NUM_USERS}`);
  console.log(`  Users per Product: ${USERS_PER_PRODUCT}`);
  console.log(`  Expected Success: ~${estimatedTotalStock} (${(estimatedTotalStock / NUM_USERS * 100).toFixed(0)}%)`);
  console.log(`  Expected OUT_OF_STOCK: ~${NUM_USERS - estimatedTotalStock} (${((NUM_USERS - estimatedTotalStock) / NUM_USERS * 100).toFixed(0)}%)`);

  console.log('\n' + '='.repeat(70));
  console.log('🚀 Starting load test...');
  console.log('='.repeat(70) + '\n');

  return { 
    productIds: PRODUCT_IDS, 
    initialStock,
    expectedSuccess: estimatedTotalStock,
    expectedFail: NUM_USERS - estimatedTotalStock,
  };
}

// ============================================
// TEARDOWN
// ============================================
export function teardown(data) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 FINAL RESULTS');
  console.log('='.repeat(70));

  let totalSold = 0;
  let totalRemaining = 0;
  let hasOverselling = false;
  const oversoldProducts = [];

  // Check final status for sample products
  console.log('\n📦 Final stock status (sample):');
  
  const checkIndices = [
    ...Array.from({ length: Math.min(5, data.productIds.length) }, (_, i) => i),
    ...Array.from({ length: Math.min(5, data.productIds.length) }, (_, i) => data.productIds.length - 5 + i).filter(i => i >= 5)
  ];

  for (const i of checkIndices) {
    const productId = data.productIds[i];
    const res = http.get(`${API_BASE}/seckill/status/${productId}`);
    
    if (res.status === 200) {
      const status = JSON.parse(res.body);
      const sold = status.totalStock - status.stockRemaining;
      
      totalSold += sold;
      totalRemaining += status.stockRemaining;
      
      let statusIcon = '○';
      if (status.stockRemaining < 0) {
        statusIcon = '❌';
        hasOverselling = true;
        oversoldProducts.push({ index: i + 1, productId, oversold: Math.abs(status.stockRemaining) });
      } else if (status.stockRemaining === 0) {
        statusIcon = '✓';
      }
      
      console.log(`  ${statusIcon} Product ${i + 1}: sold=${sold}/${status.totalStock}, remaining=${status.stockRemaining}`);
    }
  }

  if (data.productIds.length > 10) {
    console.log(`  ... checking all ${data.productIds.length} products for overselling...`);
    
    // Check all products for overselling
    for (let i = 0; i < data.productIds.length; i++) {
      if (checkIndices.includes(i)) continue; // Already checked
      
      const productId = data.productIds[i];
      const res = http.get(`${API_BASE}/seckill/status/${productId}`);
      
      if (res.status === 200) {
        const status = JSON.parse(res.body);
        if (status.stockRemaining < 0) {
          hasOverselling = true;
          oversoldProducts.push({ index: i + 1, productId, oversold: Math.abs(status.stockRemaining) });
        }
        totalSold += status.totalStock - status.stockRemaining;
        totalRemaining += status.stockRemaining;
      }
    }
  }

  // Summary
  console.log('\n' + '-'.repeat(70));
  console.log('📈 SUMMARY:');
  console.log(`  Total Products: ${data.productIds.length}`);
  console.log(`  Expected Total Stock: ${data.expectedSuccess}`);
  console.log(`  Total Users: ${NUM_USERS}`);
  console.log(`  Expected Success Rate: ${(data.expectedSuccess / NUM_USERS * 100).toFixed(1)}%`);
  
  if (hasOverselling) {
    console.log('\n  ❌ OVERSELLING DETECTED!');
    console.log(`  Oversold products: ${oversoldProducts.length}`);
    oversoldProducts.slice(0, 10).forEach(p => {
      console.log(`    - Product ${p.index}: oversold by ${p.oversold}`);
    });
    if (oversoldProducts.length > 10) {
      console.log(`    ... and ${oversoldProducts.length - 10} more`);
    }
    console.log('\n  ❌ TEST FAILED: System allowed overselling!');
  } else {
    console.log('\n  ✅ NO OVERSELLING DETECTED');
    console.log('  ✅ TEST PASSED: Stock integrity maintained');
  }

  console.log('\n' + '='.repeat(70));
  console.log('✅ Load test completed!');
  console.log('='.repeat(70) + '\n');
}
