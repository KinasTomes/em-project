#!/usr/bin/env node

/**
 * E2E Test: Order Cancellation (Insufficient Stock)
 *
 * Flow to force CANCELLED:
 * 1) Register/login
 * 2) Create a product with small stock (e.g., 1)
 * 3) Create an order requesting larger quantity (e.g., 5)
 * 4) Poll /orders/:id until status becomes CANCELLED
 *
 * Usage:
 *   node tests/e2e-order-cancelled.js
 *   API_BASE=http://localhost:3003 node tests/e2e-order-cancelled.js
 */

const http = require('http');
const https = require('https');

// Config
const API_BASE = process.env.API_BASE || 'http://localhost:3003';
const POLL_INTERVAL = 1000; // ms
const MAX_WAIT_TIME = 45000; // ms

// Terminal colors
const C = {
  R: '\x1b[31m',
  G: '\x1b[32m',
  Y: '\x1b[33m',
  B: '\x1b[34m',
  C: '\x1b[36m',
  BR: '\x1b[1m',
  RS: '\x1b[0m',
};

function log(s, color = '') { console.log(`${color}${s}${C.RS}`); }
function step(n, s) { log(`\n${'='.repeat(60)}\n[STEP ${n}] ${s}\n${'='.repeat(60)}`, C.C+ C.BR); }
function ok(s) { log(`✓ ${s}`, C.G); }
function err(s) { log(`✗ ${s}`, C.R); }
function info(s) { log(`  ${s}`, C.B); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) options.headers['Authorization'] = token.startsWith('Bearer ')? token : `Bearer ${token}`;

    const payload = body ? JSON.stringify(body) : null;
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json = {};
        try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  const username = `e2e_cancel_${Date.now()}`;
  const password = 'SecureP@ssw0rd123';
  let token, productId, orderId;

  log('\n' + '█'.repeat(60), C.G + C.BR);
  log('  E2E TEST: Order Cancellation (Insufficient Stock)', C.G + C.BR);
  log('█'.repeat(60) + '\n', C.G + C.BR);
  info(`API Base: ${API_BASE}`);
  info(`Username: ${username}`);

  try {
    // 1) Register
    step(1, 'Register User');
    {
      const { status, data } = await request('POST', '/auth/register', { username, password });
      if (status === 200 || status === 201) ok('User registered'); else if (status === 400) ok('User already exists'); else {
        err(`Register failed: ${status}`); info(JSON.stringify(data)); throw new Error('register');
      }
    }

    // 2) Login
    step(2, 'Login');
    {
      const { status, data } = await request('POST', '/auth/login', { username, password });
      if (status !== 200 || !data.token) { err(`Login failed: ${status}`); info(JSON.stringify(data)); throw new Error('login'); }
      token = data.token; ok('Logged in'); info(`Token: ${token.slice(0,20)}...`);
    }

    // 3) Create product with low stock (1)
    step(3, 'Create Low-Stock Product (available=1)');
    {
      const body = { name: `E2E Cancel Product ${Date.now()}`, price: 50, description: 'E2E cancel path', available: 1 };
      const { status, data } = await request('POST', '/products', body, token);
      if (status !== 201) { err(`Create product failed: ${status}`); info(JSON.stringify(data)); throw new Error('product'); }
      productId = data._id || data.id; if (!productId) throw new Error('no productId');
      ok('Product created'); info(`Product ID: ${productId}`);
    }

    // 4) Create order with higher quantity (5) to force reserve failure
    step(4, 'Create Order (quantity > stock to force CANCELLED)');
    {
      const body = { productIds: [productId], quantities: [5] };
      const { status, data } = await request('POST', '/orders', body, token);
      if (status !== 201) { err(`Create order failed: ${status}`); info(JSON.stringify(data)); throw new Error('order'); }
      orderId = data.orderId; if (!orderId) throw new Error('no orderId');
      ok('Order created (PENDING)'); info(`Order ID: ${orderId}`);
    }

    // 5) Poll until CANCELLED
    step(5, 'Polling Order Status (expect CANCELLED)');
    const start = Date.now(); let attempts = 0; let final;
    while (Date.now() - start < MAX_WAIT_TIME) {
      attempts++;
      const { status, data } = await request('GET', `/orders/${orderId}`, null, token);
      if (status !== 200) { info(`Attempt ${attempts}: read ${status}`); await sleep(POLL_INTERVAL); continue; }
      info(`[Attempt ${attempts}] Current status: ${data.status}`);
      if (data.status === 'CANCELLED') { final = data; break; }
      if (data.status === 'CONFIRMED') { err('Order CONFIRMED unexpectedly'); info(JSON.stringify(data)); throw new Error('unexpected-confirmed'); }
      await sleep(POLL_INTERVAL);
    }
    if (!final) { err(`Timeout waiting CANCELLED after ${MAX_WAIT_TIME}ms`); throw new Error('timeout-cancelled'); }

    // 6) Report success
    ok('Order reached CANCELLED as expected');
    info(`Order details: ${JSON.stringify(final, null, 2)}`);
    log('\n' + '█'.repeat(60), C.G + C.BR);
    log('  ✓ E2E CANCEL TEST PASSED', C.G + C.BR);
    log('█'.repeat(60) + '\n', C.G + C.BR);
    process.exit(0);

  } catch (e) {
    log('\n' + '█'.repeat(60), C.R + C.BR);
    log('  ✗ E2E CANCEL TEST FAILED', C.R + C.BR);
    log('█'.repeat(60), C.R + C.BR);
    err(e.message);
    if (e.stack) { log('\nStack:', C.Y); console.log(e.stack); }
    process.exit(1);
  }
}

run();
