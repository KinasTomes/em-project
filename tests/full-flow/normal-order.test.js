#!/usr/bin/env node

/**
 * Test Full Flow: Normal Order (POST /orders)
 * 
 * Scenario:
 * - Tạo 1 product với stock = 2
 * - 2 users mua cùng lúc
 * - Cả 2 đều phải thành công (đủ stock)
 * - Không xóa data sau khi test
 * 
 * Usage:
 *   node tests/full-flow/normal-order.test.js
 * 
 * Environment:
 *   API_BASE=http://localhost:3003
 *   JWT_SECRET=your-jwt-secret
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ============================================
// CONFIG - Điền vào đây
// ============================================
const CONFIG = {
  API_BASE: process.env.API_BASE || 'http://35.213.165.98:3003',
  JWT_SECRET: process.env.JWT_SECRET || '98w4jt9083w47t93w84tu3w094d8tw3j9o845t87j3w9od4857kw38457w39d458k7d3w94oo58k3w9045',  // <-- ĐIỀN JWT_SECRET
};

// ============================================
// JWT Helper
// ============================================
function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  
  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

function generateToken(userId) {
  return createJWT({
    id: userId,
    username: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }, CONFIG.JWT_SECRET);
}

// ============================================
// HTTP Helper
// ============================================
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.API_BASE);
    const client = url.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// COLORS
// ============================================
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bright: '\x1b[1m',
};

function log(msg, color = c.reset) {
  console.log(`${color}${msg}${c.reset}`);
}

// ============================================
// MAIN TEST
// ============================================
async function main() {
  const testId = Date.now();
  
  log('\n' + '='.repeat(60), c.cyan);
  log('🛒 TEST: Normal Order Flow (POST /orders)', c.bright + c.cyan);
  log('='.repeat(60), c.cyan);
  log(`API: ${CONFIG.API_BASE}`);
  log(`Test ID: ${testId}`);
  log('Scenario: 1 product (stock=2), 2 buyers');
  log('='.repeat(60) + '\n', c.cyan);

  if (!CONFIG.JWT_SECRET) {
    log('❌ ERROR: JWT_SECRET chưa được cấu hình!', c.red);
    log('Hãy set JWT_SECRET trong file hoặc environment variable', c.yellow);
    process.exit(1);
  }

  // Setup users
  const user1 = `test-user1-${testId}`;
  const user2 = `test-user2-${testId}`;
  const token1 = generateToken(user1);
  const token2 = generateToken(user2);

  let productId;
  const orders = [];

  try {
    // ========== STEP 1: Create Product ==========
    log('[STEP 1] Tạo product với stock = 2', c.bright);
    
    const productRes = await request('POST', '/products', {
      name: `Test Product ${testId}`,
      price: 100000,
      description: 'Test product for normal order flow',
      available: 2,
    }, { Authorization: `Bearer ${token1}` });

    if (productRes.status !== 201 && productRes.status !== 200) {
      throw new Error(`Failed to create product: ${productRes.status} - ${JSON.stringify(productRes.data)}`);
    }

    productId = productRes.data._id;
    log(`  ✓ Product created: ${productId}`, c.green);

    // ========== STEP 2: Both users buy concurrently ==========
    log('\n[STEP 2] 2 users mua cùng lúc', c.bright);

    const buyPromises = [
      request('POST', '/orders', { ids: [productId], quantities: [1] }, { Authorization: `Bearer ${token1}` }),
      request('POST', '/orders', { ids: [productId], quantities: [1] }, { Authorization: `Bearer ${token2}` }),
    ];

    const results = await Promise.all(buyPromises);

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      const user = i === 0 ? user1 : user2;
      
      if (res.status === 201) {
        orders.push({ user, orderId: res.data.orderId, status: res.data.status });
        log(`  ✓ User ${i + 1} (${user}): Order created - ${res.data.orderId} [${res.data.status}]`, c.green);
      } else {
        log(`  ✗ User ${i + 1} (${user}): Failed - ${res.status} ${JSON.stringify(res.data)}`, c.red);
      }
    }

    // ========== STEP 3: Wait and poll order status ==========
    log('\n[STEP 3] Chờ SAGA xử lý và kiểm tra status', c.bright);
    log('  Waiting 5s for async processing...', c.blue);
    await sleep(5000);

    for (const order of orders) {
      const token = order.user === user1 ? token1 : token2;
      const statusRes = await request('GET', `/orders/${order.orderId}`, null, { Authorization: `Bearer ${token}` });
      
      if (statusRes.status === 200) {
        order.finalStatus = statusRes.data.status;
        order.cancellationReason = statusRes.data.cancellationReason;
        
        const statusColor = statusRes.data.status === 'PAID' ? c.green : 
                           statusRes.data.status === 'CANCELLED' ? c.red : c.yellow;
        log(`  📦 ${order.user}: ${order.orderId} → ${statusRes.data.status}${statusRes.data.cancellationReason ? ` (${statusRes.data.cancellationReason})` : ''}`, statusColor);
      } else {
        log(`  ⚠️ ${order.user}: Failed to get status - ${statusRes.status}`, c.yellow);
      }
    }

    // ========== STEP 4: Summary ==========
    log('\n' + '='.repeat(60), c.cyan);
    log('📊 SUMMARY', c.bright + c.cyan);
    log('='.repeat(60), c.cyan);
    
    log(`\nProduct ID: ${productId}`, c.blue);
    log('Orders created:', c.blue);
    for (const order of orders) {
      log(`  - ${order.orderId} (${order.user}) → ${order.finalStatus || order.status}`, c.blue);
    }

    const successCount = orders.filter(o => o.finalStatus === 'PAID' || o.finalStatus === 'CONFIRMED').length;
    const pendingCount = orders.filter(o => o.finalStatus === 'PENDING').length;
    const cancelledCount = orders.filter(o => o.finalStatus === 'CANCELLED').length;

    log(`\nResults: ${successCount} success, ${pendingCount} pending, ${cancelledCount} cancelled`, c.blue);
    
    if (orders.length === 2) {
      log('\n✅ TEST PASSED: Cả 2 orders đều được tạo', c.bright + c.green);
    } else {
      log('\n⚠️ TEST WARNING: Không đủ 2 orders', c.yellow);
    }

    log('\n📝 NOTE: Data không bị xóa. Product và Orders vẫn còn trong DB.', c.yellow);
    log('='.repeat(60) + '\n', c.cyan);

  } catch (error) {
    log(`\n❌ ERROR: ${error.message}`, c.red);
    console.error(error);
    process.exit(1);
  }
}

main();
