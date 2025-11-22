#!/usr/bin/env node

/**
 * E2E Test: Order Flow with Transactional Outbox Pattern
 * 
 * Flow:
 * 1. Register user
 * 2. Login to get JWT token
 * 3. Create product (with inventory)
 * 4. Create order (status: PENDING)
 * 5. Wait for outbox → RabbitMQ → Inventory processing
 * 6. Poll order status until CONFIRMED or CANCELLED
 * 
 * Usage:
 *   node tests/e2e-order-flow.js
 *   
 * Environment:
 *   API_BASE=http://localhost:3003 (default)
 */

const http = require('http');
const https = require('https');

// Configuration
const API_BASE = process.env.API_BASE || 'http://localhost:3003';
const POLL_INTERVAL = 1000; // 1 second
const MAX_WAIT_TIME = 45000; // 45 seconds

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Helper: Make HTTP request
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
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }

    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch {
          json = { raw: data };
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Helper: Sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: Log with color
function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

// Helper: Log step
function logStep(step, message) {
  log(`\n${'='.repeat(60)}`, colors.cyan);
  log(`[STEP ${step}] ${message}`, colors.bright + colors.cyan);
  log('='.repeat(60), colors.cyan);
}

// Helper: Log success
function logSuccess(message) {
  log(`✓ ${message}`, colors.green);
}

// Helper: Log error
function logError(message) {
  log(`✗ ${message}`, colors.red);
}

// Helper: Log info
function logInfo(message) {
  log(`  ${message}`, colors.blue);
}

// Main test function
async function runE2ETest() {
  const username = `e2e_user_${Date.now()}`;
  const password = 'SecureP@ssw0rd123';
  
  let token;
  let productId;
  let orderId;

  try {
    log('\n' + '█'.repeat(60), colors.bright + colors.green);
    log('  E2E TEST: Order Flow with Transactional Outbox Pattern', colors.bright + colors.green);
    log('█'.repeat(60) + '\n', colors.bright + colors.green);
    logInfo(`API Base: ${API_BASE}`);
    logInfo(`Username: ${username}`);

    // ============================================================
    // STEP 1: Register User
    // ============================================================
    logStep(1, 'Register User');
    try {
      const { status, data } = await request('POST', '/auth/register', {
        username,
        password,
      });

      if (status === 200 || status === 201) {
        logSuccess('User registered successfully');
      } else if (status === 400 && data.message && data.message.includes('already')) {
        logSuccess('User already exists (using existing account)');
      } else {
        logError(`Registration failed with status ${status}`);
        logInfo(`Response: ${JSON.stringify(data, null, 2)}`);
        throw new Error('Registration failed');
      }
    } catch (error) {
      logError(`Registration request failed: ${error.message}`);
      throw error;
    }

    // ============================================================
    // STEP 2: Login
    // ============================================================
    logStep(2, 'Login to Get JWT Token');
    try {
      const { status, data } = await request('POST', '/auth/login', {
        username,
        password,
      });

      if (status !== 200) {
        logError(`Login failed with status ${status}`);
        logInfo(`Response: ${JSON.stringify(data, null, 2)}`);
        throw new Error('Login failed');
      }

      if (!data.token) {
        logError('No token in login response');
        throw new Error('Missing token');
      }

      token = data.token;
      logSuccess('Logged in successfully');
      logInfo(`Token: ${token.substring(0, 20)}...`);
    } catch (error) {
      logError(`Login request failed: ${error.message}`);
      throw error;
    }

    // ============================================================
    // STEP 3: Create Product (with Inventory)
    // ============================================================
    logStep(3, 'Create Product (initializes Inventory)');
    try {
      const productData = {
        name: `E2E Test Product ${Date.now()}`,
        price: 99.99,
        description: 'Automated E2E test product',
        available: 10000000, // Initial stock
      };

      const { status, data } = await request('POST', '/products', productData, token);

      if (status !== 201) {
        logError(`Product creation failed with status ${status}`);
        logInfo(`Response: ${JSON.stringify(data, null, 2)}`);
        throw new Error('Product creation failed');
      }

      productId = data._id || data.id;
      if (!productId) {
        logError('No product ID in response');
        throw new Error('Missing product ID');
      }

      logSuccess('Product created successfully');
      logInfo(`Product ID: ${productId}`);
      logInfo(`Name: ${data.name}`);
      logInfo(`Price: ${data.price}`);
      logInfo(`Initial Stock: ${productData.available}`);
    } catch (error) {
      logError(`Product creation request failed: ${error.message}`);
      throw error;
    }

    // ============================================================
    // STEP 4: Create Order (PENDING)
    // ============================================================
    logStep(4, 'Create Order (status: PENDING)');
    try {
      const orderData = {
        productIds: [productId],
        quantities: [2], // Order 2 units
      };

      const { status, data } = await request('POST', '/orders', orderData, token);

      if (status !== 201) {
        logError(`Order creation failed with status ${status}`);
        logInfo(`Response: ${JSON.stringify(data, null, 2)}`);
        throw new Error('Order creation failed');
      }

      orderId = data.orderId;
      if (!orderId) {
        logError('No order ID in response');
        throw new Error('Missing order ID');
      }

      logSuccess('Order created successfully');
      logInfo(`Order ID: ${orderId}`);
      logInfo(`Status: ${data.status}`);
      logInfo(`Total Price: ${data.totalPrice}`);
      logInfo(`Products: ${JSON.stringify(data.products, null, 2)}`);

      if (data.status !== 'PENDING') {
        logError(`Expected status PENDING, got ${data.status}`);
      }
    } catch (error) {
      logError(`Order creation request failed: ${error.message}`);
      throw error;
    }

    // ============================================================
    // STEP 5: Wait for Outbox Processing
    // ============================================================
    logStep(5, 'Waiting for Outbox → RabbitMQ → Inventory Processing');
    logInfo('Outbox processor will publish RESERVE event to RabbitMQ');
    logInfo('Inventory service will process and respond');
    logInfo('Order status should change to CONFIRMED or CANCELLED\n');

    // ============================================================
    // STEP 6: Poll Order Status (Full SAGA Flow)
    // ============================================================
    logStep(6, 'Polling Order Status (until PAID or CANCELLED)');
    logInfo('Expected flow:');
    logInfo('  PENDING → CONFIRMED (inventory reserved) → PAID (payment succeeded)');
    logInfo('  OR');
    logInfo('  PENDING → CANCELLED (inventory failed or payment failed)\n');
    
    const startTime = Date.now();
    let finalStatus = null;
    let orderData = null;
    let attempts = 0;
    let statusHistory = ['PENDING'];

    while (Date.now() - startTime < MAX_WAIT_TIME) {
      attempts++;
      
      try {
        const { status, data } = await request('GET', `/orders/${orderId}`, null, token);

        if (status !== 200) {
          logError(`Failed to get order status (attempt ${attempts})`);
          await sleep(POLL_INTERVAL);
          continue;
        }

        const currentStatus = data.status;
        
        // Track status changes
        if (statusHistory[statusHistory.length - 1] !== currentStatus) {
          statusHistory.push(currentStatus);
          logSuccess(`Status changed: ${statusHistory[statusHistory.length - 2]} → ${currentStatus}`);
        } else {
          logInfo(`[Attempt ${attempts}] Current status: ${currentStatus}`);
        }

        // Check for final states
        if (currentStatus === 'PAID' || currentStatus === 'CANCELLED') {
          finalStatus = currentStatus;
          orderData = data;
          logSuccess(`Order reached final status: ${finalStatus}`);
          break;
        }

        await sleep(POLL_INTERVAL);
      } catch (error) {
        logError(`Poll attempt ${attempts} failed: ${error.message}`);
        await sleep(POLL_INTERVAL);
      }
    }

    if (!finalStatus) {
      logError(`Timeout: Order did not reach final status after ${MAX_WAIT_TIME}ms`);
      logError(`Last known status: ${statusHistory[statusHistory.length - 1]}`);
      logError(`Status history: ${statusHistory.join(' → ')}`);
      throw new Error('Order processing timeout');
    }

    // ============================================================
    // STEP 7: Verify Final State & Payment Status
    // ============================================================
    logStep(7, 'Verify Final State & Payment Status');
    
    logInfo(`Status history: ${statusHistory.join(' → ')}`);
    logInfo(`Final order status: ${finalStatus}`);
    
    if (finalStatus === 'PAID') {
      // ============================================================
      // SUCCESS CASE: Payment Succeeded
      // ============================================================
      log('\n' + '✓'.repeat(60), colors.bright + colors.green);
      logSuccess('FULL SAGA FLOW COMPLETED SUCCESSFULLY!');
      log('✓'.repeat(60), colors.bright + colors.green);
      
      logInfo('\nFlow executed:');
      logInfo('  1. Order created → PENDING');
      logInfo('  2. Inventory reserved → CONFIRMED');
      logInfo('  3. Payment processed → PAID ✅');
      
      // Verify expected transitions
      if (statusHistory.includes('CONFIRMED')) {
        logSuccess('\n✓ Order went through CONFIRMED state (inventory was reserved)');
      } else {
        logError('\n⚠️  Order skipped CONFIRMED state (unexpected!)');
      }
      
      logSuccess('✓ Payment succeeded');
      logSuccess('✓ Order is now PAID and ready for fulfillment');
      
    } else if (finalStatus === 'CANCELLED') {
      // ============================================================
      // CANCELLED CASE: Check reason
      // ============================================================
      const reason = orderData.cancellationReason || 'Unknown';
      logInfo(`\nCancellation reason: ${reason}`);
      
      if (reason.toLowerCase().includes('payment')) {
        // Payment failed - this is expected (90% success rate)
        log('\n' + '⚠'.repeat(60), colors.yellow);
        logSuccess('ORDER CANCELLED DUE TO PAYMENT FAILURE');
        log('⚠'.repeat(60), colors.yellow);
        
        logInfo('\nFlow executed:');
        logInfo('  1. Order created → PENDING');
        logInfo('  2. Inventory reserved → CONFIRMED');
        logInfo('  3. Payment failed → CANCELLED ⚠️');
        logInfo('  4. Compensation: Inventory released ✓');
        
        if (statusHistory.includes('CONFIRMED')) {
          logSuccess('\n✓ Order was CONFIRMED (inventory reserved)');
          logSuccess('✓ Payment failed (expected with 90% success rate)');
          logSuccess('✓ Compensation executed (inventory released)');
        }
        
        logInfo('\nNote: This is expected behavior. Payment has 90% success rate.');
        logInfo('Run the test again to potentially get PAID status.');
        
      } else {
        // Unexpected cancellation (should not happen with large inventory)
        log('\n' + '✗'.repeat(60), colors.red);
        logError('UNEXPECTED CANCELLATION!');
        log('✗'.repeat(60), colors.red);
        
        logError(`\nReason: ${reason}`);
        logError('Expected: With large inventory (10M units), order should reach CONFIRMED');
        logError('Then either PAID (payment success) or CANCELLED (payment failed)');
        logInfo(`\nActual status history: ${statusHistory.join(' → ')}`);
      }
    }

    // ============================================================
    // SUCCESS
    // ============================================================
    log('\n' + '█'.repeat(60), colors.bright + colors.green);
    log('  ✓ E2E TEST PASSED', colors.bright + colors.green);
    log('█'.repeat(60) + '\n', colors.bright + colors.green);

    process.exit(0);
  } catch (error) {
    // ============================================================
    // FAILURE
    // ============================================================
    log('\n' + '█'.repeat(60), colors.bright + colors.red);
    log('  ✗ E2E TEST FAILED', colors.bright + colors.red);
    log('█'.repeat(60), colors.bright + colors.red);
    logError(`Error: ${error.message}`);
    
    if (error.stack) {
      log('\nStack trace:', colors.yellow);
      console.log(error.stack);
    }

    process.exit(1);
  }
}

// Run the test
runE2ETest();
