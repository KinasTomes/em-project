#!/usr/bin/env node

/**
 * E2E Test: Offline RabbitMQ and Change Stream Resume
 *
 * Scenarios
 *  A) RabbitMQ offline → POST order → Outbox persists → Start RabbitMQ → Auto-publish → Order reaches final status
 *  B) Change Stream resume after restart:
 *     Stop RabbitMQ → POST order (PENDING, outbox event inserted)
 *     Restart Order service → Start RabbitMQ → Processor should publish pending event → Order reaches final status
 *
 * Usage:
 *   node tests/e2e-offline-change-stream.js
 *
 * Environment:
 *   API_BASE=http://localhost:3003 (default)
 *   RABBIT_USER=guest (default)
 *   RABBIT_PASS=guest (default)
 */

const { exec } = require('child_process');
const http = require('http');
const https = require('https');

// Configuration
const API_BASE = process.env.API_BASE || 'http://localhost:3003';
const RABBIT_USER = process.env.RABBIT_USER || 'guest';
const RABBIT_PASS = process.env.RABBIT_PASS || 'guest';
const RABBIT_MGMT = 'http://localhost:15672';
const POLL_INTERVAL = 1000; // 1s
const MAX_WAIT = 60000; // 60s per polling phase
const STARTUP_WAIT = 8000; // initial wait after bringing stack up

// Colors
const C = {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', c: '\x1b[36m', w: '\x1b[37m', reset: '\x1b[0m', bold: '\x1b[1m'
};
const log = (msg, color=C.reset) => console.log(`${color}${msg}${C.reset}`);
const info = (msg) => log(`  ${msg}`, C.b);
const ok = (msg) => log(`✓ ${msg}`, C.g);
const warn = (msg) => log(`⚠ ${msg}`, C.y);
const err = (msg) => log(`✗ ${msg}`, C.r);
const step = (n, text) => { log('\n' + '='.repeat(60), C.c); log(`[STEP ${n}] ${text}`, C.bold + C.c); log('='.repeat(60), C.c); };
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// HTTP helpers
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
    if (token) options.headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let json; try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function requestRabbit(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(RABBIT_MGMT + path);
    const auth = Buffer.from(`${RABBIT_USER}:${RABBIT_PASS}`).toString('base64');
    const options = {
      hostname: url.hostname,
      port: url.port || 15672,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitRabbitHealthy(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { status } = await requestRabbit('/api/overview');
      if (status === 200) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

// Docker helpers
function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const out = (stdout || '') + (stderr || '');
        return reject(new Error(out.trim() || error.message));
      }
      resolve(stdout.trim());
    });
  });
}

async function dc(args) {
  try {
    return await execCmd(`docker compose ${args}`);
  } catch (e) {
    // fallback for older setups
    return await execCmd(`docker-compose ${args}`);
  }
}

async function bringUpStack() {
  step('0A', 'Bring up stack (compose up -d)');
  info('Starting Docker Compose services...');
  await dc('up -d');
  info('Waiting a moment for services to settle...');
  await sleep(STARTUP_WAIT);
}

// Domain helpers
async function registerAndLogin() {
  const username = `e2e_offline_${Date.now()}`;
  const password = 'SecureP@ssw0rd123';

  step(1, 'Register & Login');
  const reg = await request('POST', '/auth/register', { username, password });
  if (!(reg.status === 200 || reg.status === 201 || (reg.status === 400 && JSON.stringify(reg.data).includes('already')))) {
    throw new Error(`Registration failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  }
  ok('User ready');
  const login = await request('POST', '/auth/login', { username, password });
  if (login.status !== 200 || !login.data?.token) throw new Error(`Login failed: ${login.status} ${JSON.stringify(login.data)}`);
  ok('Logged in');
  info(`Token: ${login.data.token.substring(0, 18)}...`);
  return login.data.token;
}

async function createProduct(token, available = 10) {
  step(2, 'Create Product (initial stock)');
  const body = { name: `E2E Offline ${Date.now()}`, price: 99.99, description: 'offline test', available };
  const res = await request('POST', '/products', body, token);
  if (res.status !== 201) throw new Error(`Create product failed: ${res.status} ${JSON.stringify(res.data)}`);
  const productId = res.data._id || res.data.id;
  if (!productId) throw new Error(`Missing product id in response: ${JSON.stringify(res.data)}`);
  ok('Product created');
  info(`Product ID: ${productId}`);
  return productId;
}

async function postOrder(token, productId, qty = 2) {
  const body = { productIds: [productId], quantities: [qty] };
  const res = await request('POST', '/orders', body, token);
  if (res.status !== 201) throw new Error(`Create order failed: ${res.status} ${JSON.stringify(res.data)}`);
  const orderId = res.data.orderId;
  if (!orderId) throw new Error(`Missing orderId in response: ${JSON.stringify(res.data)}`);
  info(`Order created: ${orderId}, status=${res.data.status}`);
  return { orderId, status: res.data.status };
}

async function getOrder(token, orderId) {
  const res = await request('GET', `/orders/${orderId}`, null, token);
  if (res.status !== 200) throw new Error(`Get order failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

async function pollOrderToFinal(token, orderId, timeoutMs = MAX_WAIT) {
  step('POLL', `Polling order ${orderId} to final (CONFIRMED/CANCELLED)`);
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const d = await getOrder(token, orderId);
      info(`[Attempt ${attempt}] status=${d.status}`);
      if (d.status === 'CONFIRMED' || d.status === 'CANCELLED') { ok(`Final status: ${d.status}`); return d.status; }
    } catch (e) {
      warn(`Poll error: ${e.message}`);
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Timeout waiting for final status (${timeoutMs}ms)`);
}

async function scenarioA(token, productId) {
  step('A1', 'Stop RabbitMQ');
  await dc('stop rabbitmq');
  ok('RabbitMQ stopped');

  step('A2', 'POST order while RabbitMQ is down');
  const { orderId } = await postOrder(token, productId, 2);
  const d1 = await getOrder(token, orderId);
  if (d1.status !== 'PENDING') warn(`Expected PENDING, got ${d1.status}`);
  info('Waiting briefly to ensure outbox persist...');
  await sleep(3000);

  step('A3', 'Start RabbitMQ and wait for health');
  await dc('start rabbitmq');
  const healthy = await waitRabbitHealthy(30000);
  if (!healthy) warn('RabbitMQ management not healthy yet, continuing anyway');

  // Ensure both Inventory and Order consumers reconnect
  step('A4', 'Restart Inventory and Order to re-establish consumers');
  await dc('restart inventory');
  await dc('restart order');
  await sleep(4000);

  const status = await pollOrderToFinal(token, orderId, MAX_WAIT);
  ok(`Scenario A completed, order=${orderId}, status=${status}`);
  return { orderId, status };

}

async function scenarioB(token, productId) {
  step('B1', 'Stop RabbitMQ');
  await dc('stop rabbitmq');
  ok('RabbitMQ stopped');

  step('B2', 'POST order with broker down (outbox inserted)');
  const { orderId } = await postOrder(token, productId, 3);
  const d1 = await getOrder(token, orderId);
  info(`Before restart, order status=${d1.status}`);

  step('B3', 'Restart Order service');
  await dc('restart order');
  ok('Order service restarted');
  await sleep(4000);

  step('B4', 'Start RabbitMQ and wait for health');
  await dc('start rabbitmq');
  const healthy = await waitRabbitHealthy(30000);
  if (!healthy) warn('RabbitMQ management not healthy yet, continuing anyway');

  // Ensure Inventory consumer reconnects
  step('B5', 'Restart Inventory to re-establish consumer');
  await dc('restart inventory');
  await sleep(3000);

  try {
    const status = await pollOrderToFinal(token, orderId, MAX_WAIT);
    ok(`Scenario B completed, order=${orderId}, status=${status}`);
    return { orderId, status };
  } catch (e) {
    // Provide actionable hint if resume on startup isn't implemented
    err('Scenario B timed out. This likely means the Outbox processor does not scan existing PENDING events on startup.');
    info('Consider implementing a startup recovery scan that picks PENDING events and republishes.');
    throw e;
  }
}

async function main() {
  log('\n' + '█'.repeat(60), C.bold + C.g);
  log('  E2E: Offline RabbitMQ + Change Stream Resume', C.bold + C.g);
  log('█'.repeat(60) + '\n', C.bold + C.g);
  info(`API Base: ${API_BASE}`);

  try {
    // Ensure stack is up (idempotent)
    await bringUpStack();

    const token = await registerAndLogin();
    const productId = await createProduct(token, 10);

    // Scenario A
    const a = await scenarioA(token, productId);

    // Scenario B
    const b = await scenarioB(token, productId);

    log('\n' + '█'.repeat(60), C.bold + C.g);
    log('  ✓ OFFLINE/RESUME E2E PASSED', C.bold + C.g);
    log('█'.repeat(60) + '\n', C.bold + C.g);
    info(`A: order=${a.orderId} status=${a.status}`);
    info(`B: order=${b.orderId} status=${b.status}`);
    process.exit(0);
  } catch (e) {
    log('\n' + '█'.repeat(60), C.bold + C.r);
    log('  ✗ OFFLINE/RESUME E2E FAILED', C.bold + C.r);
    log('█'.repeat(60), C.bold + C.r);
    err(e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
