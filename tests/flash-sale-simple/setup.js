/**
 * Setup Script - Chạy trước khi test
 * 
 * Tạo products và init seckill campaigns
 * Output: danh sách product IDs để dùng trong test
 * 
 * Usage:
 *   node tests/flash-sale-simple/setup.js
 * 
 * Environment:
 *   API_BASE=http://localhost:3000
 *   ADMIN_KEY=admin-secret-key
 *   JWT_SECRET=your-jwt-secret
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ============================================
// CONFIG
// ============================================
const CONFIG = {
  API_BASE: process.env.API_BASE || 'http://35.213.165.98:3003',
  ADMIN_KEY: process.env.ADMIN_KEY || 'super-gay-key-for-femboi-usage',
  JWT_SECRET: process.env.JWT_SECRET || '98w4jt9083w47t93w84tu3w094d8tw3j9o845t87j3w9od4857kw38457w39d458k7d3w94oo58k3w9045',  // <-- ĐIỀN VÀO
  NUM_PRODUCTS: parseInt(process.env.NUM_PRODUCTS || '3'),
  STOCK_PER_PRODUCT: parseInt(process.env.STOCK_PER_PRODUCT || '15'),
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
      path: url.pathname,
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


// ============================================
// MAIN
// ============================================
async function main() {
  console.log('='.repeat(60));
  console.log('🚀 FLASH SALE SETUP');
  console.log('='.repeat(60));
  console.log(`API: ${CONFIG.API_BASE}`);
  console.log(`Products: ${CONFIG.NUM_PRODUCTS}`);
  console.log(`Stock/product: ${CONFIG.STOCK_PER_PRODUCT}`);
  console.log('='.repeat(60));

  const token = generateToken('admin-setup');
  const productIds = [];

  // 1. Tạo Products
  console.log('\n📦 Creating products...');
  for (let i = 1; i <= CONFIG.NUM_PRODUCTS; i++) {
    const res = await request('POST', '/products', {
      name: `Flash Sale Product ${i}`,
      price: 1000000 * i,
      description: `Test product ${i}`,
      available: 1000,
    }, { Authorization: `Bearer ${token}` });

    if (res.status === 201 || res.status === 200) {
      productIds.push(res.data._id);
      console.log(`  ✓ Product ${i}: ${res.data._id}`);
    } else {
      console.log(`  ✗ Product ${i} failed: ${res.status}`);
    }
  }

  // 2. Init Seckill Campaigns
  console.log('\n🎯 Initializing campaigns...');
  const now = new Date();
  const startTime = new Date(now.getTime() - 60000).toISOString();
  const endTime = new Date(now.getTime() + 3600000).toISOString();

  for (let i = 0; i < productIds.length; i++) {
    const res = await request('POST', '/admin/seckill/init', {
      productId: productIds[i],
      stock: CONFIG.STOCK_PER_PRODUCT,
      price: 500000 * (i + 1),
      startTime,
      endTime,
    }, { 'X-Admin-Key': CONFIG.ADMIN_KEY });

    if (res.status === 200 || res.status === 201) {
      console.log(`  ✓ Campaign ${i + 1}: ${productIds[i]} (${CONFIG.STOCK_PER_PRODUCT} slots)`);
    } else {
      console.log(`  ✗ Campaign ${i + 1} failed: ${res.status} - ${JSON.stringify(res.data)}`);
    }
  }

  // 3. Output for k6 test
  console.log('\n' + '='.repeat(60));
  console.log('✅ SETUP COMPLETE');
  console.log('='.repeat(60));
  console.log('\nProduct IDs (copy to k6 test):');
  console.log(`const PRODUCT_IDS = ${JSON.stringify(productIds)};`);
  console.log('\nOr run k6 with:');
  console.log(`k6 run -e PRODUCT_IDS='${JSON.stringify(productIds)}' tests/flash-sale-simple/load.test.js`);
  console.log('='.repeat(60));

  return productIds;
}

main().catch(console.error);
