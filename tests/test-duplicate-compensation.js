/**
 * Detailed Duplicate Compensation Test
 * 
 * This test specifically validates:
 * 1. Idempotency - duplicate PAYMENT_FAILED messages are processed only once
 * 2. Logs show "already processed" or "skipping duplicate" messages
 * 3. Stock is released exactly once, not twice
 */

const axios = require('axios');
const amqp = require('amqplib');

// Service URLs
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3005';
const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3004';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

// Test state
let authToken = null;
let testProductId = null;
let rabbitConnection = null;
let rabbitChannel = null;

// Utility functions
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Setup RabbitMQ
async function setupRabbitMQ() {
  rabbitConnection = await amqp.connect(RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();
  log('✓', 'Connected to RabbitMQ');
}

// Cleanup RabbitMQ
async function cleanupRabbitMQ() {
  try {
    if (rabbitChannel) await rabbitChannel.close();
    if (rabbitConnection) await rabbitConnection.close();
    log('✓', 'RabbitMQ connections closed');
  } catch (error) {
    log('⚠️', 'Error closing RabbitMQ connections');
  }
}

// Get inventory state
async function getInventoryState(productId) {
  try {
    const response = await axios.get(
      `${INVENTORY_URL}/api/inventory/${productId}`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    return response.data;
  } catch (error) {
    log('✗', 'Failed to get inventory state', error.response?.data || error.message);
    throw error;
  }
}

// Setup user and authentication
async function setupUser() {
  log('🔧', 'Setting up test user...');
  
  const username = `test_dup_${Date.now()}`;
  const password = 'TestPass123!';
  
  // Register
  try {
    await axios.post(`${AUTH_URL}/register`, {
      username,
      password,
      email: `${username}@test.com`,
    });
    log('✓', 'User registered', { username });
  } catch (error) {
    if (error.response?.status !== 400) {
      throw error;
    }
  }
  
  // Login
  const loginResponse = await axios.post(`${AUTH_URL}/login`, {
    username,
    password,
  });
  authToken = loginResponse.data.token;
  log('✓', 'Logged in successfully');
}

// Create test product
async function setupProduct() {
  log('🔧', 'Creating test product...');
  
  const productData = {
    name: `Test Product ${Date.now()}`,
    price: 99.99,
    description: 'Test product for duplicate compensation',
    stock: 100,
    category: 'Test',
  };
  
  const response = await axios.post(`${PRODUCT_URL}/api/products`, productData, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  
  testProductId = response.data._id;
  log('✓', 'Product created', { productId: testProductId });
  
  // Wait for inventory to initialize
  await sleep(1000);
  
  // Add stock
  await axios.post(
    `${INVENTORY_URL}/api/inventory/${testProductId}/restock`,
    { quantity: 100 },
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  log('✓', 'Inventory stocked with 100 units');
}

// Main test
async function testDuplicateCompensation() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 DUPLICATE COMPENSATION TEST - DETAILED IDEMPOTENCY CHECK');
  console.log('='.repeat(80) + '\n');
  
  try {
    // Setup
    await setupRabbitMQ();
    await setupUser();
    await setupProduct();
    
    console.log('\n' + '-'.repeat(80));
    console.log('📊 TEST SCENARIO: Duplicate PAYMENT_FAILED Events');
    console.log('-'.repeat(80) + '\n');
    
    // Step 1: Get initial state
    log('1️⃣', 'Getting initial inventory state...');
    const initialState = await getInventoryState(testProductId);
    log('📦', 'Initial state:', {
      available: initialState.available,
      reserved: initialState.reserved,
    });
    
    // Step 2: Reserve some inventory
    log('2️⃣', 'Reserving 10 units...');
    const orderId = `order-dup-${Date.now()}`;
    const eventId = `event-dup-${Date.now()}`;
    
    await axios.post(
      `${INVENTORY_URL}/api/inventory/${testProductId}/reserve`,
      { quantity: 10, orderId },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    
    await sleep(1000);
    const afterReserve = await getInventoryState(testProductId);
    log('📦', 'After reserve:', {
      available: afterReserve.available,
      reserved: afterReserve.reserved,
    });
    
    if (afterReserve.reserved !== 10) {
      log('✗', 'Reserve failed - expected 10 reserved, got ' + afterReserve.reserved);
      return false;
    }
    
    // Step 3: Publish PAYMENT_FAILED event TWICE with same eventId
    log('3️⃣', 'Publishing PAYMENT_FAILED event (1st time)...');
    const paymentFailedEvent = {
      orderId,
      eventId, // Same eventId for both messages!
      products: [{ productId: testProductId, quantity: 10 }],
      reason: 'Card declined',
      timestamp: new Date().toISOString(),
    };
    
    await rabbitChannel.assertQueue('PAYMENT_FAILED', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'PAYMENT_FAILED.dlq'
      }
    });
    
    // First message
    rabbitChannel.sendToQueue(
      'PAYMENT_FAILED',
      Buffer.from(JSON.stringify(paymentFailedEvent)),
      {
        persistent: true,
        messageId: eventId,
        correlationId: orderId,
      }
    );
    log('📤', 'FIRST PAYMENT_FAILED published', { eventId, orderId });
    
    // Wait a bit
    await sleep(500);
    
    // Second message (DUPLICATE - same eventId!)
    log('4️⃣', 'Publishing PAYMENT_FAILED event (2nd time - DUPLICATE)...');
    rabbitChannel.sendToQueue(
      'PAYMENT_FAILED',
      Buffer.from(JSON.stringify(paymentFailedEvent)),
      {
        persistent: true,
        messageId: eventId, // SAME eventId!
        correlationId: orderId,
      }
    );
    log('📤', 'SECOND PAYMENT_FAILED published (DUPLICATE)', { eventId, orderId });
    
    // Step 4: Wait for processing
    log('5️⃣', 'Waiting 8 seconds for compensation processing...');
    log('👀', 'During this time, check inventory service logs for:');
    log('   ', '- "Message already processed" or "Skipping duplicate"');
    log('   ', '- Only ONE compensation execution (not two)');
    
    await sleep(8000);
    
    // Step 5: Check final state
    log('6️⃣', 'Checking final inventory state...');
    const finalState = await getInventoryState(testProductId);
    log('📦', 'Final state:', {
      available: finalState.available,
      reserved: finalState.reserved,
    });
    
    // Step 6: Verify results
    console.log('\n' + '-'.repeat(80));
    console.log('✅ TEST RESULTS');
    console.log('-'.repeat(80) + '\n');
    
    const expectedAvailable = initialState.available;
    const expectedReserved = 0;
    
    log('📊', 'Expected:', { available: expectedAvailable, reserved: expectedReserved });
    log('📊', 'Actual:', { available: finalState.available, reserved: finalState.reserved });
    
    if (finalState.available === expectedAvailable && finalState.reserved === expectedReserved) {
      log('✅', '✅ TEST PASSED: Stock released exactly ONCE despite duplicate events!');
      log('✅', 'Idempotency working correctly - duplicate message was ignored');
      
      console.log('\n' + '-'.repeat(80));
      console.log('📋 VERIFICATION CHECKLIST:');
      console.log('-'.repeat(80));
      console.log('✓ Stock reserved: 10 units');
      console.log('✓ PAYMENT_FAILED published twice with same eventId');
      console.log('✓ Stock released: 10 units (only once, not 20)');
      console.log('✓ Final inventory matches initial state');
      console.log('\n💡 Check inventory service logs for idempotency skip message');
      console.log('   Expected log: "Message already processed" or "Skipping duplicate"');
      console.log('-'.repeat(80) + '\n');
      
      return true;
    } else {
      log('✗', '❌ TEST FAILED: Stock state incorrect!');
      log('✗', 'Idempotency may not be working - stock may have been released twice');
      
      if (finalState.available > expectedAvailable) {
        log('⚠️', `Stock was OVER-RELEASED by ${finalState.available - expectedAvailable} units!`);
        log('⚠️', 'This indicates the duplicate message was NOT skipped!');
      }
      
      return false;
    }
    
  } catch (error) {
    log('✗', 'Test failed with error:', error.message);
    if (error.response) {
      log('✗', 'Error details:', error.response.data);
    }
    return false;
  } finally {
    await cleanupRabbitMQ();
  }
}

// Run test
async function main() {
  const startTime = Date.now();
  
  console.log('\n' + '█'.repeat(80));
  console.log('  DUPLICATE COMPENSATION TEST - IDEMPOTENCY VALIDATION');
  console.log('█'.repeat(80) + '\n');
  
  const result = await testDuplicateCompensation();
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  
  console.log('\n' + '█'.repeat(80));
  console.log(`  TEST COMPLETED IN ${duration}s - ${result ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('█'.repeat(80) + '\n');
  
  // Now show how to check logs
  console.log('🔍 TO VERIFY IDEMPOTENCY IN LOGS, RUN:');
  console.log('─'.repeat(80));
  console.log('docker compose logs inventory --since 2m | Select-String -Pattern "already processed|duplicate|skip|idempotency"');
  console.log('─'.repeat(80) + '\n');
  
  process.exit(result ? 0 : 1);
}

main();
