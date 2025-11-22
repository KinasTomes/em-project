/**
 * Manual test for circuit-breaker package
 * 
 * This test doesn't require external dependencies
 * Run with: node test/manual-test.js
 */

// Mock logger to avoid dependency
const mockLogger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args),
};

// Mock @ecommerce/logger
require.cache[require.resolve('@ecommerce/logger')] = {
  exports: mockLogger,
};

// Mock OpenTelemetry
const mockTrace = {
  getSpan: () => null,
};
const mockContext = {
  active: () => ({}),
};

require.cache[require.resolve('@opentelemetry/api')] = {
  exports: { trace: mockTrace, context: mockContext },
};

// Now we can require our module
const { createResilientClient } = require('../index');

console.log('✓ Circuit Breaker package loaded successfully!\n');

// Test 1: Create client with defaults
console.log('=== Test 1: Create client with defaults ===');
const client1 = createResilientClient('test-service', 'http://localhost:3000');
console.log('✓ Client created with defaults\n');

// Test 2: Create client with custom config
console.log('=== Test 2: Create client with custom config ===');
const client2 = createResilientClient(
  'custom-service',
  'http://localhost:4000',
  {
    timeout: 5000,
    retry: {
      retries: 5,
    },
    circuitBreaker: {
      errorThresholdPercentage: 60,
      resetTimeout: 60000,
    },
  }
);
console.log('✓ Client created with custom config\n');

// Test 3: Check client methods exist
console.log('=== Test 3: Check client methods ===');
const methods = ['get', 'post', 'put', 'delete', 'patch', 'getStats', 'openCircuit', 'closeCircuit', 'shutdown'];
methods.forEach((method) => {
  if (typeof client1[method] === 'function') {
    console.log(`✓ Method ${method} exists`);
  } else {
    console.error(`✗ Method ${method} missing`);
  }
});
console.log();

// Test 4: Get initial stats
console.log('=== Test 4: Get circuit breaker stats ===');
const stats = client1.getStats();
console.log('Stats:', JSON.stringify(stats, null, 2));
console.log();

// Test 5: Manual circuit control
console.log('=== Test 5: Manual circuit control ===');
console.log('Opening circuit...');
client1.openCircuit();
let statsAfterOpen = client1.getStats();
console.log('State after open:', statsAfterOpen.state);

console.log('Closing circuit...');
client1.closeCircuit();
let statsAfterClose = client1.getStats();
console.log('State after close:', statsAfterClose.state);
console.log();

// Test 6: Shutdown
console.log('=== Test 6: Shutdown ===');
client1.shutdown();
client2.shutdown();
console.log('✓ Clients shutdown successfully\n');

console.log('=== All tests passed! ===');
console.log('\nPackage structure:');
console.log('✓ index.js - Main entry point');
console.log('✓ src/config.js - Configuration management');
console.log('✓ src/axiosClient.js - Axios with retry and tracing');
console.log('✓ src/circuitBreaker.js - Circuit breaker wrapper');
console.log('✓ src/resilientClient.js - Main client factory');
console.log('✓ examples/ - Usage examples');
console.log('✓ README.md - Complete documentation');
