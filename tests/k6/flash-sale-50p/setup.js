/**
 * Setup Script - Flash Sale 50 Products
 * 
 * Tạo 50 products, mỗi product có seckill stock = 50
 * Dùng với k6 test 100 users (2 user/product → 100% success rate expected)
 * 
 * Usage:
 *   node tests/k6/flash-sale-50p/setup.js
 * 
 * Environment:
 *   API_BASE=http://localhost:3003
 *   ADMIN_KEY=admin-secret-key
 *   JWT_SECRET=your-jwt-secret
 *   NUM_PRODUCTS=50
 *   STOCK_PER_PRODUCT=50
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIG
// ============================================
const CONFIG = {
  API_BASE: process.env.API_BASE || 'http://35.213.165.98:3003',
  ADMIN_KEY: process.env.ADMIN_KEY || 'super-gay-key-for-femboi-usage',
  JWT_SECRET: process.env.JWT_SECRET || '98w4jt9083w47t93w84tu3w094d8tw3j9o845t87j3w9od4857kw38457w39d458k7d3w94oo58k3w9045',
  NUM_PRODUCTS: parseInt(process.env.NUM_PRODUCTS || '50'),
  STOCK_PER_PRODUCT: parseInt(process.env.STOCK_PER_PRODUCT || '50'),
  CONCURRENT_SETUP: parseInt(process.env.CONCURRENT_SETUP || '10'), // Parallel requests
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
      timeout: 30000,
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
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ============================================
// Batch helper
// ============================================
async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ============================================
// MAIN
// ============================================
async function main() {
  const testId = Date.now();
  
  console.log('='.repeat(70));
  console.log('🚀 FLASH SALE SETUP - 50 Products x 50 Stock');
  console.log('='.repeat(70));
  console.log(`API: ${CONFIG.API_BASE}`);
  console.log(`Products: ${CONFIG.NUM_PRODUCTS}`);
  console.log(`Stock/product: ${CONFIG.STOCK_PER_PRODUCT}`);
  console.log(`Total stock: ${CONFIG.NUM_PRODUCTS * CONFIG.STOCK_PER_PRODUCT}`);
  console.log(`Test ID: ${testId}`);
  console.log('='.repeat(70));

  const token = generateToken('admin-setup');
  const productIds = [];
  const failedProducts = [];

  // 1. Tạo Products
  console.log('\n📦 Creating products...');
  const productIndices = Array.from({ length: CONFIG.NUM_PRODUCTS }, (_, i) => i + 1);
  
  await runInBatches(productIndices, CONFIG.CONCURRENT_SETUP, async (i) => {
    try {
      const res = await request('POST', '/products', {
        name: `Flash Sale P${i} - ${testId}`,
        price: 1000000,
        description: `Test product ${i} for flash sale load test`,
        available: 1000,
      }, { Authorization: `Bearer ${token}` });

      if (res.status === 201 || res.status === 200) {
        productIds.push({ index: i, id: res.data._id });
        process.stdout.write(`\r  ✓ Created ${productIds.length}/${CONFIG.NUM_PRODUCTS} products`);
      } else {
        failedProducts.push({ index: i, error: `${res.status}: ${JSON.stringify(res.data)}` });
      }
    } catch (err) {
      failedProducts.push({ index: i, error: err.message });
    }
  });

  console.log(); // New line after progress

  if (failedProducts.length > 0) {
    console.log(`\n  ⚠️ ${failedProducts.length} products failed to create`);
    failedProducts.slice(0, 5).forEach(f => console.log(`    - Product ${f.index}: ${f.error}`));
  }

  // Sort by index to maintain order
  productIds.sort((a, b) => a.index - b.index);
  const sortedIds = productIds.map(p => p.id);

  // 2. Init Seckill Campaigns
  console.log('\n🎯 Initializing seckill campaigns...');
  const now = new Date();
  const startTime = new Date(now.getTime() - 60000).toISOString();
  const endTime = new Date(now.getTime() + 7200000).toISOString(); // 2 hours

  let campaignSuccess = 0;
  const failedCampaigns = [];

  await runInBatches(sortedIds, CONFIG.CONCURRENT_SETUP, async (productId) => {
    try {
      const res = await request('POST', '/admin/seckill/init', {
        productId,
        stock: CONFIG.STOCK_PER_PRODUCT,
        price: 500000,
        startTime,
        endTime,
      }, { 'X-Admin-Key': CONFIG.ADMIN_KEY });

      if (res.status === 200 || res.status === 201) {
        campaignSuccess++;
        process.stdout.write(`\r  ✓ Initialized ${campaignSuccess}/${sortedIds.length} campaigns`);
      } else {
        failedCampaigns.push({ productId, error: `${res.status}: ${JSON.stringify(res.data)}` });
      }
    } catch (err) {
      failedCampaigns.push({ productId, error: err.message });
    }
  });

  console.log(); // New line after progress

  if (failedCampaigns.length > 0) {
    console.log(`\n  ⚠️ ${failedCampaigns.length} campaigns failed to init`);
    failedCampaigns.slice(0, 5).forEach(f => console.log(`    - ${f.productId}: ${f.error}`));
  }

  // 3. Save product IDs to file
  const outputFile = path.join(__dirname, 'product-ids.json');
  fs.writeFileSync(outputFile, JSON.stringify(sortedIds, null, 2));

  // 4. Output summary
  console.log('\n' + '='.repeat(70));
  console.log('✅ SETUP COMPLETE');
  console.log('='.repeat(70));
  console.log(`\nProducts created: ${sortedIds.length}/${CONFIG.NUM_PRODUCTS}`);
  console.log(`Campaigns initialized: ${campaignSuccess}/${sortedIds.length}`);
  console.log(`Total stock available: ${campaignSuccess * CONFIG.STOCK_PER_PRODUCT}`);
  console.log(`\nProduct IDs saved to: ${outputFile}`);
  
  const numUsers = CONFIG.NUM_PRODUCTS * 50; // 50 users per product
  console.log('\n📋 Run k6 test with:');
  console.log(`k6 run -e PRODUCT_IDS='${JSON.stringify(sortedIds)}' -e NUM_USERS=${numUsers} tests/k6/flash-sale-50p/load.test.js`);
  
  console.log('\nOr use the saved file:');
  console.log(`k6 run tests/k6/flash-sale-50p/load.test.js`);
  
  console.log(`\n💡 Test config: ${numUsers} users competing for ${campaignSuccess * CONFIG.STOCK_PER_PRODUCT} stock items`);
  console.log(`   Expected success rate: ~100% (each product has ${CONFIG.STOCK_PER_PRODUCT} stock, ${CONFIG.STOCK_PER_PRODUCT} users compete)`);
  
  console.log('\n' + '='.repeat(70));

  return sortedIds;
}

main().catch(err => {
  console.error('❌ Setup failed:', err);
  process.exit(1);
});
