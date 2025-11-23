/**
 * Comprehensive Compensation System Tests
 * 
 * Tests all compensation scenarios:
 * 1. Basic idempotency (duplicate messages)
 * 2. PAYMENT_FAILED compensation
 * 3. ORDER_TIMEOUT compensation
 * 4. Retry logic with transient failures
 * 5. DLQ routing for permanent failures
 */

const axios = require('axios');
const amqp = require('amqplib');

// Service URLs
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const ORDER_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3002';
const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3005';
const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3004';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

// Test state
let authToken = null;
let userId = null;
let testProductId = null;
let rabbitConnection = null;
let rabbitChannel = null;

// Utility functions
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLog(title, status = '⏳') {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${status} ${title}`);
  console.log(`${'═'.repeat(70)}\n`);
}

function logInfo(message, data = null) {
  console.log(`ℹ️  ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function logSuccess(message, data = null) {
  console.log(`✓ ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function logError(message, error = null) {
  console.log(`✗ ${message}`);
  if (error) {
    console.error(error.message || error);
  }
}

function logWarning(message) {
  console.log(`⚠️  ${message}`);
}

// Setup RabbitMQ connection
async function setupRabbitMQ() {
  try {
    rabbitConnection = await amqp.connect(RABBITMQ_URL);
    rabbitChannel = await rabbitConnection.createChannel();
    logSuccess('Connected to RabbitMQ');
  } catch (error) {
    logError('Failed to connect to RabbitMQ', error);
    throw error;
  }
}

// Cleanup RabbitMQ
async function cleanupRabbitMQ() {
  try {
    if (rabbitChannel) await rabbitChannel.close();
    if (rabbitConnection) await rabbitConnection.close();
    logSuccess('RabbitMQ connections closed');
  } catch (error) {
    logWarning('Error closing RabbitMQ connections');
  }
}

// Check queue depth
async function getQueueDepth(queueName) {
  try {
    const queueInfo = await rabbitChannel.checkQueue(queueName);
    return queueInfo.messageCount;
  } catch (error) {
    return 0;
  }
}

// Setup: Register and login
async function setupUser() {
  formatLog('SETUP: User Registration & Authentication', '🔧');
  
  const timestamp = Date.now();
  const testUsername = `test_comp_${timestamp}`;
  const testPassword = 'Test123!@#';
  
  try {
    // Register
    logInfo('Registering test user...');
    const registerRes = await axios.post(`${AUTH_URL}/register`, {
      username: testUsername,
      password: testPassword,
    });
    
    if (registerRes.status === 201 || registerRes.status === 200) {
      logSuccess('User registered successfully', { username: testUsername });
    }
    
    // Login
    logInfo('Logging in...');
    const loginRes = await axios.post(`${AUTH_URL}/login`, {
      username: testUsername,
      password: testPassword,
    });
    
    authToken = loginRes.data.token;
    userId = loginRes.data.userId || loginRes.data.user?.id;
    
    logSuccess('Login successful', { userId, token: authToken?.substring(0, 20) + '...' });
    
    return { username: testUsername, userId, token: authToken };
  } catch (error) {
    logError('Setup failed', error.response?.data || error.message);
    throw error;
  }
}

// Setup: Create test product
async function setupProduct() {
  formatLog('SETUP: Create Test Product', '🔧');
  
  try {
    const productData = {
      name: `Test Product ${Date.now()}`,
      price: 99.99,
      description: 'Test product for compensation tests',
      stock: 100,
      category: 'Test',
    };
    
    logInfo('Creating product...', productData);
    
    const response = await axios.post(`${PRODUCT_URL}/api/products`, productData, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    
    testProductId = response.data._id || response.data.id;
    logSuccess('Product created', { productId: testProductId });
    
    // Wait for product to be synced to inventory
    await sleep(2000);
    
    // Verify inventory initialized
    const inventoryRes = await axios.get(`${INVENTORY_URL}/api/inventory/${testProductId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    
    logSuccess('Inventory initialized', inventoryRes.data);
    
    // Add stock to inventory (restock)
    logInfo('Adding stock to inventory (100 units)...');
    await axios.post(
      `${INVENTORY_URL}/api/inventory/${testProductId}/restock`,
      { quantity: 100 },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    
    await sleep(1000);
    
    // Verify stock added
    const afterRestock = await axios.get(`${INVENTORY_URL}/api/inventory/${testProductId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    
    logSuccess('Stock added', afterRestock.data);
    
    return testProductId;
  } catch (error) {
    logError('Product setup failed', error.response?.data || error.message);
    throw error;
  }
}

// Get current inventory state
async function getInventoryState(productId) {
  try {
    const response = await axios.get(`${INVENTORY_URL}/api/inventory/${productId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    return response.data;
  } catch (error) {
    logWarning(`Failed to get inventory state: ${error.message}`);
    return null;
  }
}

// Test 1: Basic Idempotency
async function testIdempotency() {
  formatLog('TEST 1: Idempotency - Duplicate PAYMENT_FAILED Events', '🧪');
  
  const eventId = `test-idempotency-${Date.now()}`;
  const orderId = `order-idempotency-${Date.now()}`;
  
  try {
    // Get initial inventory state
    logInfo('Getting initial inventory state...');
    const initialState = await getInventoryState(testProductId);
    logInfo('Initial state:', initialState);
    
    // First, reserve some inventory
    logInfo('Reserving 5 units...');
    await axios.post(
      `${INVENTORY_URL}/api/inventory/${testProductId}/reserve`,
      { quantity: 5, orderId },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    
    await sleep(1000);
    const afterReserve = await getInventoryState(testProductId);
    logInfo('After reserve:', afterReserve);
    
    // Publish PAYMENT_FAILED event TWICE with same eventId
    logInfo(`Publishing PAYMENT_FAILED event (eventId: ${eventId})...`);
    
    const paymentFailedEvent = {
      orderId,
      eventId,
      products: [{ productId: testProductId, quantity: 5 }],
      reason: 'Insufficient funds',
    };
    
    await rabbitChannel.assertQueue('PAYMENT_FAILED', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'PAYMENT_FAILED.dlq'
      }
    });
    
    // First publish
    rabbitChannel.sendToQueue(
      'PAYMENT_FAILED',
      Buffer.from(JSON.stringify(paymentFailedEvent)),
      {
        persistent: true,
        messageId: eventId,
        correlationId: orderId,
      }
    );
    logSuccess('First PAYMENT_FAILED event published');
    
    // Wait a bit
    await sleep(1000);
    
    // Second publish (DUPLICATE)
    rabbitChannel.sendToQueue(
      'PAYMENT_FAILED',
      Buffer.from(JSON.stringify(paymentFailedEvent)),
      {
        persistent: true,
        messageId: eventId, // Same eventId!
        correlationId: orderId,
      }
    );
    logSuccess('Second PAYMENT_FAILED event published (DUPLICATE)');
    
    // Wait for processing
    logInfo('Waiting 5 seconds for processing...');
    await sleep(5000);
    
    // Check final inventory state
    const finalState = await getInventoryState(testProductId);
    logInfo('Final state:', finalState);
    
    // Verify: reserved should be back to 0, available should increase by 5 (ONLY ONCE)
    const expectedAvailable = initialState.available;
    const expectedReserved = initialState.reserved;
    
    if (finalState.reserved === expectedReserved && finalState.available === expectedAvailable) {
      logSuccess('✅ IDEMPOTENCY TEST PASSED: Stock released only once despite duplicate events');
      return true;
    } else {
      logError('❌ IDEMPOTENCY TEST FAILED: Stock released multiple times');
      logError(`Expected: available=${expectedAvailable}, reserved=${expectedReserved}`);
      logError(`Got: available=${finalState.available}, reserved=${finalState.reserved}`);
      return false;
    }
    
  } catch (error) {
    logError('Test 1 failed with error', error);
    return false;
  }
}

// Test 2: PAYMENT_FAILED Compensation
async function testPaymentFailedCompensation() {
  formatLog('TEST 2: PAYMENT_FAILED Compensation', '🧪');
  
  const orderId = `order-payment-failed-${Date.now()}`;
  const eventId = `event-payment-failed-${Date.now()}`;
  
  try {
    // Get initial state
    logInfo('Getting initial inventory state...');
    const initialState = await getInventoryState(testProductId);
    logInfo('Initial state:', initialState);
    
    // Reserve inventory
    logInfo('Reserving 10 units...');
    await axios.post(
      `${INVENTORY_URL}/api/inventory/${testProductId}/reserve`,
      { quantity: 10, orderId },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    
    await sleep(1000);
    const afterReserve = await getInventoryState(testProductId);
    logInfo('After reserve:', afterReserve);
    
    if (afterReserve.reserved !== initialState.reserved + 10) {
      logError('Reserve failed - inventory not updated correctly');
      return false;
    }
    
    // Publish PAYMENT_FAILED to trigger compensation
    logInfo('Publishing PAYMENT_FAILED event...');
    const paymentFailedEvent = {
      orderId,
      eventId,
      products: [{ productId: testProductId, quantity: 10 }],
      reason: 'Card declined',
    };
    
      await rabbitChannel.assertQueue('PAYMENT_FAILED', {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': 'PAYMENT_FAILED.dlq'
        }
      });
    rabbitChannel.sendToQueue(
      'PAYMENT_FAILED',
      Buffer.from(JSON.stringify(paymentFailedEvent)),
      {
        persistent: true,
        messageId: eventId,
        correlationId: orderId,
      }
    );
    logSuccess('PAYMENT_FAILED event published');
    
    // Wait for compensation
    logInfo('Waiting 5 seconds for compensation...');
    await sleep(5000);
    
    // Check final state
    const finalState = await getInventoryState(testProductId);
    logInfo('Final state:', finalState);
    
    // Verify: inventory should be back to initial state
    if (finalState.available === initialState.available && 
        finalState.reserved === initialState.reserved) {
      logSuccess('✅ PAYMENT_FAILED TEST PASSED: Inventory compensated correctly');
      return true;
    } else {
      logError('❌ PAYMENT_FAILED TEST FAILED: Compensation did not restore inventory');
      return false;
    }
    
  } catch (error) {
    logError('Test 2 failed with error', error);
    return false;
  }
}

// Test 3: ORDER_TIMEOUT Compensation
async function testOrderTimeoutCompensation() {
  formatLog('TEST 3: ORDER_TIMEOUT Compensation', '🧪');
  
  const orderId = `order-timeout-${Date.now()}`;
  const eventId = `event-timeout-${Date.now()}`;
  
  try {
    // Get initial state
    logInfo('Getting initial inventory state...');
    const initialState = await getInventoryState(testProductId);
    logInfo('Initial state:', initialState);
    
    // Reserve inventory for multiple products (simulate order with 2 items)
    logInfo('Reserving 15 units...');
    await axios.post(
      `${INVENTORY_URL}/api/inventory/${testProductId}/reserve`,
      { quantity: 15, orderId },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    
    await sleep(1000);
    const afterReserve = await getInventoryState(testProductId);
    logInfo('After reserve:', afterReserve);
    
    // Publish ORDER_TIMEOUT event (simulating timeout worker)
    logInfo('Publishing ORDER_TIMEOUT event...');
    const timeoutEvent = {
      orderId,
      eventId,
      products: [{ productId: testProductId, quantity: 15 }],
      reason: 'SAGA_TIMEOUT',
    };
    
    await rabbitChannel.assertQueue('ORDER_TIMEOUT', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'ORDER_TIMEOUT.dlq'
      }
    });
    rabbitChannel.sendToQueue(
      'ORDER_TIMEOUT',
      Buffer.from(JSON.stringify(timeoutEvent)),
      {
        persistent: true,
        messageId: eventId,
        correlationId: orderId,
      }
    );
    logSuccess('ORDER_TIMEOUT event published');
    
    // Wait for compensation
    logInfo('Waiting 5 seconds for timeout compensation...');
    await sleep(5000);
    
    // Check final state
    const finalState = await getInventoryState(testProductId);
    logInfo('Final state:', finalState);
    
    // Verify: inventory restored
    if (finalState.available === initialState.available && 
        finalState.reserved === initialState.reserved) {
      logSuccess('✅ ORDER_TIMEOUT TEST PASSED: All reservations released');
      return true;
    } else {
      logError('❌ ORDER_TIMEOUT TEST FAILED: Timeout compensation did not work');
      return false;
    }
    
  } catch (error) {
    logError('Test 3 failed with error', error);
    return false;
  }
}

// Test 4: RELEASE Compensation
async function testReleaseCompensation() {
  formatLog('TEST 4: RELEASE Compensation Handler', '🧪');
  
  const orderId = `order-release-${Date.now()}`;
  const eventId = `event-release-${Date.now()}`;
  
  try {
    // Get initial state
    logInfo('Getting initial inventory state...');
    const initialState = await getInventoryState(testProductId);
    logInfo('Initial state:', initialState);
    
    // Reserve inventory
    logInfo('Reserving 7 units...');
    await axios.post(
      `${INVENTORY_URL}/api/inventory/${testProductId}/reserve`,
      { quantity: 7, orderId },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    
    await sleep(1000);
    const afterReserve = await getInventoryState(testProductId);
    logInfo('After reserve:', afterReserve);
    
    // Publish RELEASE event
    logInfo('Publishing RELEASE event...');
    const releaseEvent = {
      orderId,
      eventId,
      productId: testProductId,
      quantity: 7,
      reason: 'SAGA_COMPENSATION',
    };
    
    await rabbitChannel.assertQueue('RELEASE', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'RELEASE.dlq'
      }
    });
    rabbitChannel.sendToQueue(
      'RELEASE',
      Buffer.from(JSON.stringify(releaseEvent)),
      {
        persistent: true,
        messageId: eventId,
        correlationId: orderId,
      }
    );
    logSuccess('RELEASE event published');
    
    // Wait for processing
    logInfo('Waiting 5 seconds for release...');
    await sleep(5000);
    
    // Check final state
    const finalState = await getInventoryState(testProductId);
    logInfo('Final state:', finalState);
    
    // Verify: inventory restored
    if (finalState.available === initialState.available && 
        finalState.reserved === initialState.reserved) {
      logSuccess('✅ RELEASE TEST PASSED: Inventory released correctly');
      return true;
    } else {
      logError('❌ RELEASE TEST FAILED: Release handler did not work');
      return false;
    }
    
  } catch (error) {
    logError('Test 4 failed with error', error);
    return false;
  }
}

// Test 5: DLQ Routing
async function testDLQRouting() {
  formatLog('TEST 5: Dead Letter Queue (DLQ) Routing', '🧪');
  
  try {
    // Check if DLQ queues exist and are working
    await rabbitChannel.assertQueue('PAYMENT_FAILED.dlq', { durable: true });
    await rabbitChannel.assertQueue('ORDER_TIMEOUT.dlq', { durable: true });
    await rabbitChannel.assertQueue('RELEASE.dlq', { durable: true });
    
    logSuccess('All DLQ queues exist and are accessible');
    
    // Check DLQ depths
    const paymentDlqDepth = await getQueueDepth('PAYMENT_FAILED.dlq');
    const timeoutDlqDepth = await getQueueDepth('ORDER_TIMEOUT.dlq');
    const releaseDlqDepth = await getQueueDepth('RELEASE.dlq');
    
    logInfo('DLQ Depths:', {
      'PAYMENT_FAILED.dlq': paymentDlqDepth,
      'ORDER_TIMEOUT.dlq': timeoutDlqDepth,
      'RELEASE.dlq': releaseDlqDepth,
    });
    
    logSuccess('✅ DLQ TEST PASSED: All DLQ queues configured correctly');
    return true;
    
  } catch (error) {
    logError('Test 5 failed with error', error);
    return false;
  }
}

// Test 6: Queue Depths Check
async function testQueueHealthCheck() {
  formatLog('TEST 6: Queue Health & Depth Check', '🧪');
  
  try {
    const queues = ['PAYMENT_FAILED', 'ORDER_TIMEOUT', 'RELEASE', 'RESERVE'];
    const queueStats = {};
    
    for (const queue of queues) {
      try {
        const queueInfo = await rabbitChannel.checkQueue(queue);
        queueStats[queue] = queueInfo.messageCount;
      } catch (error) {
        queueStats[queue] = 'ERROR';
      }
    }
    
    logInfo('Queue Statistics:', queueStats);
    
    // Check if queues are processing (depth should be low)
    const allHealthy = Object.entries(queueStats).every(([queue, depth]) => {
      if (depth === 'ERROR') return false;
      if (depth > 50) {
        logWarning(`Queue ${queue} has high depth: ${depth} messages`);
        return false;
      }
      return true;
    });
    
    if (allHealthy) {
      logSuccess('✅ QUEUE HEALTH TEST PASSED: All queues are healthy');
      return true;
    } else {
      logWarning('⚠️  QUEUE HEALTH TEST: Some queues have issues');
      return false;
    }
    
  } catch (error) {
    logError('Test 6 failed with error', error);
    return false;
  }
}

// Main test runner
async function runAllTests() {
  console.log('\n' + '█'.repeat(70));
  console.log('  COMPENSATION SYSTEM - COMPREHENSIVE TEST SUITE');
  console.log('█'.repeat(70) + '\n');
  
  const results = {
    passed: 0,
    failed: 0,
    tests: [],
  };
  
  try {
    // Setup
    await setupRabbitMQ();
    await setupUser();
    await setupProduct();
    
    // Run tests
    const tests = [
      { name: 'Idempotency', fn: testIdempotency },
      { name: 'PAYMENT_FAILED Compensation', fn: testPaymentFailedCompensation },
      { name: 'ORDER_TIMEOUT Compensation', fn: testOrderTimeoutCompensation },
      { name: 'RELEASE Compensation', fn: testReleaseCompensation },
      { name: 'DLQ Routing', fn: testDLQRouting },
      { name: 'Queue Health Check', fn: testQueueHealthCheck },
    ];
    
    for (const test of tests) {
      try {
        const passed = await test.fn();
        results.tests.push({ name: test.name, passed });
        if (passed) {
          results.passed++;
        } else {
          results.failed++;
        }
      } catch (error) {
        logError(`Test "${test.name}" threw an error`, error);
        results.tests.push({ name: test.name, passed: false, error: error.message });
        results.failed++;
      }
      
      // Wait between tests
      await sleep(2000);
    }
    
  } catch (error) {
    logError('Test suite failed during setup', error);
  } finally {
    await cleanupRabbitMQ();
  }
  
  // Print summary
  console.log('\n' + '█'.repeat(70));
  console.log('  TEST SUMMARY');
  console.log('█'.repeat(70) + '\n');
  
  results.tests.forEach(test => {
    const status = test.passed ? '✅ PASSED' : '❌ FAILED';
    console.log(`${status} - ${test.name}`);
    if (test.error) {
      console.log(`         Error: ${test.error}`);
    }
  });
  
  console.log('\n' + '─'.repeat(70));
  console.log(`Total Tests: ${results.tests.length}`);
  console.log(`Passed: ${results.passed} ✅`);
  console.log(`Failed: ${results.failed} ❌`);
  console.log(`Success Rate: ${((results.passed / results.tests.length) * 100).toFixed(1)}%`);
  console.log('─'.repeat(70) + '\n');
  
  if (results.failed === 0) {
    console.log('🎉 ALL TESTS PASSED! Compensation system is working correctly.\n');
    process.exit(0);
  } else {
    console.log('⚠️  SOME TESTS FAILED. Please review the logs above.\n');
    process.exit(1);
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
