#!/usr/bin/env node

/**
 * Test Full Flow: Flash Sale (POST /seckill/buy)
 * 
 * Scenario:
 * - Tạo 1 product
 * - Init seckill campaign với stock = 1
 * - 2 users mua cùng lúc
 * - Chỉ 1 user thành công, 1 user OUT_OF_STOCK
 * - Không xóa data sau khi test
 * 
 * Usage:
 *   node tests/full-flow/flash-sale.test.js
 * 
 * Environment:
 *   API_BASE=http://localhost:3003
 *   JWT_SECRET=your-jwt-secret
 *   ADMIN_KEY=admin-secret-key
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
  ADMIN_KEY: process.env.ADMIN_KEY || 'super-gay-key-for-femboi-usage',    // <-- ĐIỀN ADMIN_KEY
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
  log('⚡ TEST: Flash Sale Flow (POST /seckill/buy)', c.bright + c.cyan);
  log('='.repeat(60), c.cyan);
  log(`API: ${CONFIG.API_BASE}`);
  log(`Test ID: ${testId}`);
  log('Scenario: 1 product (seckill stock=1), 2 buyers');
  log('Expected: 1 success, 1 OUT_OF_STOCK');
  log('='.repeat(60) + '\n', c.cyan);

  if (!CONFIG.JWT_SECRET) {
    log('❌ ERROR: JWT_SECRET chưa được cấu hình!', c.red);
    process.exit(1);
  }
  if (!CONFIG.ADMIN_KEY) {
    log('❌ ERROR: ADMIN_KEY chưa được cấu hình!', c.red);
    process.exit(1);
  }

  // Setup users
  const user1 = `flash-user1-${testId}`;
  const user2 = `flash-user2-${testId}`;
  const token1 = generateToken(user1);
  const token2 = generateToken(user2);

  let productId;
  const buyResults = [];

  try {
    // ========== STEP 1: Create Product ==========
    log('[STEP 1] Tạo product', c.bright);
    
    const productRes = await request('POST', '/products', {
      name: `Flash Sale Product ${testId}`,
      price: 1000000,
      description: 'Test product for flash sale',
      available: 100, // Normal stock (seckill sẽ dùng stock riêng)
    }, { Authorization: `Bearer ${token1}` });

    if (productRes.status !== 201 && productRes.status !== 200) {
      throw new Error(`Failed to create product: ${productRes.status} - ${JSON.stringify(productRes.data)}`);
    }

    productId = productRes.data._id;
    log(`  ✓ Product created: ${productId}`, c.green);

    // ========== STEP 2: Init Seckill Campaign ==========
    log('\n[STEP 2] Init seckill campaign với stock = 1', c.bright);
    
    const now = new Date();
    const startTime = new Date(now.getTime() - 60000).toISOString(); // Started 1 min ago
    const endTime = new Date(now.getTime() + 3600000).toISOString(); // Ends in 1 hour

    const seckillRes = await request('POST', '/admin/seckill/init', {
      productId,
      stock: 1,  // Chỉ 1 slot
      price: 500000, // Flash sale price
      startTime,
      endTime,
    }, { 'X-Admin-Key': CONFIG.ADMIN_KEY });

    if (seckillRes.status !== 200 && seckillRes.status !== 201) {
      throw new Error(`Failed to init seckill: ${seckillRes.status} - ${JSON.stringify(seckillRes.data)}`);
    }

    log(`  ✓ Seckill campaign initialized (stock=1, price=500000)`, c.green);

    // Verify campaign status
    const statusRes = await request('GET', `/seckill/status/${productId}`);
    if (statusRes.status === 200) {
      log(`  📊 Campaign status: stock=${statusRes.data.stockRemaining}/${statusRes.data.totalStock}, active=${statusRes.data.isActive}`, c.blue);
    }

    // ========== STEP 3: Both users buy concurrently ==========
    log('\n[STEP 3] 2 users mua cùng lúc (race condition)', c.bright);

    const buyPromises = [
      request('POST', '/seckill/buy', { productId }, { Authorization: `Bearer ${token1}` }),
      request('POST', '/seckill/buy', { productId }, { Authorization: `Bearer ${token2}` }),
    ];

    const results = await Promise.all(buyPromises);

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      const user = i === 0 ? user1 : user2;
      
      if (res.status === 202) {
        buyResults.push({ 
          user, 
          success: true, 
          orderId: res.data.orderId,
          correlationId: res.data.correlationId || res.data.orderId,
        });
        log(`  ✓ User ${i + 1} (${user}): SUCCESS - orderId=${res.data.orderId}`, c.green);
      } else if (res.status === 409 && res.data.error === 'OUT_OF_STOCK') {
        buyResults.push({ user, success: false, reason: 'OUT_OF_STOCK' });
        log(`  ✗ User ${i + 1} (${user}): OUT_OF_STOCK (expected)`, c.yellow);
      } else if (res.status === 409 && res.data.error === 'ALREADY_PURCHASED') {
        buyResults.push({ user, success: false, reason: 'ALREADY_PURCHASED' });
        log(`  ✗ User ${i + 1} (${user}): ALREADY_PURCHASED`, c.yellow);
      } else {
        buyResults.push({ user, success: false, reason: `${res.status}: ${JSON.stringify(res.data)}` });
        log(`  ✗ User ${i + 1} (${user}): ERROR - ${res.status} ${JSON.stringify(res.data)}`, c.red);
      }
    }

    // ========== STEP 4: Check order status for successful buyer ==========
    log('\n[STEP 4] Kiểm tra order status (chờ SAGA xử lý)', c.bright);
    
    const successfulBuyer = buyResults.find(r => r.success);
    if (successfulBuyer) {
      log('  Waiting 5s for async processing...', c.blue);
      await sleep(5000);

      const token = successfulBuyer.user === user1 ? token1 : token2;
      
      // Try to get order by correlationId
      const orderRes = await request('GET', `/orders?correlationId=${successfulBuyer.correlationId}`, null, { 
        Authorization: `Bearer ${token}` 
      });
      
      if (orderRes.status === 200) {
        successfulBuyer.orderStatus = orderRes.data.status;
        successfulBuyer.realOrderId = orderRes.data.orderId;
        
        const statusColor = orderRes.data.status === 'PAID' ? c.green : 
                           orderRes.data.status === 'CANCELLED' ? c.red : c.yellow;
        log(`  📦 Order found: ${orderRes.data.orderId} → ${orderRes.data.status}${orderRes.data.cancellationReason ? ` (${orderRes.data.cancellationReason})` : ''}`, statusColor);
      } else if (orderRes.status === 404) {
        log(`  ⏳ Order not found yet (still processing)`, c.yellow);
        successfulBuyer.orderStatus = 'PROCESSING';
      } else {
        log(`  ⚠️ Failed to get order: ${orderRes.status} - ${JSON.stringify(orderRes.data)}`, c.yellow);
      }
    }

    // ========== STEP 5: Check final seckill stock ==========
    log('\n[STEP 5] Kiểm tra stock còn lại', c.bright);
    
    const finalStatusRes = await request('GET', `/seckill/status/${productId}`);
    if (finalStatusRes.status === 200) {
      const remaining = finalStatusRes.data.stockRemaining;
      const total = finalStatusRes.data.totalStock;
      
      if (remaining === 0) {
        log(`  ✓ Stock: ${remaining}/${total} (sold out - correct!)`, c.green);
      } else if (remaining < 0) {
        log(`  ❌ Stock: ${remaining}/${total} (OVERSELLING DETECTED!)`, c.red);
      } else {
        log(`  📊 Stock: ${remaining}/${total}`, c.blue);
      }
    }

    // ========== SUMMARY ==========
    log('\n' + '='.repeat(60), c.cyan);
    log('📊 SUMMARY', c.bright + c.cyan);
    log('='.repeat(60), c.cyan);
    
    log(`\nProduct ID: ${productId}`, c.blue);
    log('Buy Results:', c.blue);
    for (const result of buyResults) {
      if (result.success) {
        log(`  ✓ ${result.user}: SUCCESS (correlationId=${result.correlationId}, orderStatus=${result.orderStatus || 'unknown'})`, c.green);
      } else {
        log(`  ✗ ${result.user}: ${result.reason}`, c.yellow);
      }
    }

    const successCount = buyResults.filter(r => r.success).length;
    const outOfStockCount = buyResults.filter(r => r.reason === 'OUT_OF_STOCK').length;

    log(`\nResults: ${successCount} success, ${outOfStockCount} out_of_stock`, c.blue);
    
    // Validate expected behavior
    if (successCount === 1 && outOfStockCount === 1) {
      log('\n✅ TEST PASSED: Đúng 1 success, 1 out_of_stock (no overselling)', c.bright + c.green);
    } else if (successCount === 2) {
      log('\n❌ TEST FAILED: OVERSELLING - 2 users đều mua được với stock=1!', c.bright + c.red);
    } else if (successCount === 0) {
      log('\n⚠️ TEST WARNING: Không ai mua được', c.yellow);
    } else {
      log(`\n⚠️ TEST WARNING: Unexpected result - ${successCount} success, ${outOfStockCount} out_of_stock`, c.yellow);
    }

    log('\n📝 NOTE: Data không bị xóa. Product, Campaign và Orders vẫn còn trong DB.', c.yellow);
    log('='.repeat(60) + '\n', c.cyan);

  } catch (error) {
    log(`\n❌ ERROR: ${error.message}`, c.red);
    console.error(error);
    process.exit(1);
  }
}

main();
