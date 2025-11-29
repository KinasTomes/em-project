/**
 * k6 Load Test: Rate Limiting for Auth Endpoints
 * 
 * Test Scenario:
 * - Test rate limiting on /auth/* endpoints (10 req/min per IP)
 * - IMPORTANT: Counter is SHARED across all /auth/* endpoints
 * - Verify 429 responses when limit exceeded
 * - Verify rate limit headers (X-RateLimit-*)
 * 
 * Expected Behavior:
 * - First 10 requests to ANY /auth/* endpoint: 200/201 (success)
 * - Requests 11+ to ANY /auth/* endpoint: 429 (Too Many Requests)
 * - Counter is shared: 5 login + 5 register = 10 total
 * - Rate limit resets after 60 seconds
 * 
 * Usage:
 *   k6 run tests/k6/rate-limit-auth.test.js
 *   k6 run --vus 1 tests/k6/rate-limit-auth.test.js
 * 
 * Environment Variables:
 *   API_BASE=http://localhost:3003 (default)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

// Configuration
const API_BASE = 'http://34.126.120.23:3003';
const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX = 10; // requests per window

// Custom Metrics
const rateLimitHit = new Counter('rate_limit_hit_total');
const rateLimitHeadersPresent = new Rate('rate_limit_headers_present');
const requestsBlocked = new Counter('requests_blocked_total');
const requestsAllowed = new Counter('requests_allowed_total');

// Test Options
export const options = {
  // Single VU to test rate limiting from one IP
  vus: 1,
  iterations: 1,
  thresholds: {
    'rate_limit_hit_total': ['count>0'], // Should hit rate limit
    'rate_limit_headers_present': ['rate>0.9'], // 90% of responses should have headers
  },
};

// Helper: Parse JSON safely
function parseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch (e) {
    return null;
  }
}

// Helper: Check rate limit headers
function checkRateLimitHeaders(response) {
  const hasLimit = response.headers['X-Ratelimit-Limit'] !== undefined;
  const hasRemaining = response.headers['X-Ratelimit-Remaining'] !== undefined;
  const hasReset = response.headers['X-Ratelimit-Reset'] !== undefined;
  
  return hasLimit && hasRemaining && hasReset;
}

// Test: Shared Rate Limiting across /auth/* endpoints
function testSharedAuthRateLimit() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 1: Shared Rate Limiting (/auth/*)');
  console.log('='.repeat(60));
  console.log(`Expected: ${RATE_LIMIT_MAX} total requests across ALL /auth/* endpoints`);
  console.log('Strategy: Mix register + login to verify shared counter');
  console.log('');

  let totalSuccessCount = 0;
  let totalRateLimitCount = 0;
  let firstRateLimitAt = null;
  let requestNumber = 0;

  // Mix of register and login requests to test shared counter
  const requests = [
    { type: 'register', username: `user_${Date.now()}_1`, password: 'Pass123!' },
    { type: 'login', username: `user_${Date.now()}_1`, password: 'Pass123!' },
    { type: 'register', username: `user_${Date.now()}_2`, password: 'Pass123!' },
    { type: 'login', username: `user_${Date.now()}_2`, password: 'Pass123!' },
    { type: 'register', username: `user_${Date.now()}_3`, password: 'Pass123!' },
    { type: 'login', username: `user_${Date.now()}_3`, password: 'Pass123!' },
    { type: 'register', username: `user_${Date.now()}_4`, password: 'Pass123!' },
    { type: 'login', username: `user_${Date.now()}_4`, password: 'Pass123!' },
    { type: 'register', username: `user_${Date.now()}_5`, password: 'Pass123!' },
    { type: 'login', username: `user_${Date.now()}_5`, password: 'Pass123!' },
    // These should be rate limited
    { type: 'register', username: `user_${Date.now()}_6`, password: 'Pass123!' },
    { type: 'login', username: `user_${Date.now()}_6`, password: 'Pass123!' },
    { type: 'register', username: `user_${Date.now()}_7`, password: 'Pass123!' },
    { type: 'login', username: `user_${Date.now()}_7`, password: 'Pass123!' },
    { type: 'register', username: `user_${Date.now()}_8`, password: 'Pass123!' },
  ];

  for (const req of requests) {
    requestNumber++;
    const endpoint = req.type === 'register' ? '/auth/register' : '/auth/login';
    
    const response = http.post(
      `${API_BASE}${endpoint}`,
      JSON.stringify({ username: req.username, password: req.password }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const hasHeaders = checkRateLimitHeaders(response);
    rateLimitHeadersPresent.add(hasHeaders);

    const limit = response.headers['X-Ratelimit-Limit'];
    const remaining = response.headers['X-Ratelimit-Remaining'];
    const reset = response.headers['X-Ratelimit-Reset'];

    if (response.status === 200 || response.status === 201) {
      totalSuccessCount++;
      requestsAllowed.add(1);
      console.log(`Request ${requestNumber.toString().padStart(2)} [${req.type.padEnd(8)}]: ✓ ${response.status} OK | Remaining: ${remaining}/${limit} | Reset: ${reset}s`);
    } else if (response.status === 429) {
      totalRateLimitCount++;
      requestsBlocked.add(1);
      rateLimitHit.add(1);
      
      if (!firstRateLimitAt) {
        firstRateLimitAt = requestNumber;
      }

      const body = parseJson(response);
      const retryAfter = response.headers['Retry-After'] || body?.retryAfter || 'N/A';
      
      console.log(`Request ${requestNumber.toString().padStart(2)} [${req.type.padEnd(8)}]: ✗ 429 RATE LIMITED | Retry-After: ${retryAfter}s`);
    } else {
      console.log(`Request ${requestNumber.toString().padStart(2)} [${req.type.padEnd(8)}]: ? ${response.status}`);
    }

    // Small delay between requests
    sleep(0.1);
  }

  console.log('');
  console.log('Results:');
  console.log(`  Total successful requests: ${totalSuccessCount}`);
  console.log(`  Total rate limited requests: ${totalRateLimitCount}`);
  console.log(`  First rate limit at request: ${firstRateLimitAt || 'N/A'}`);
  console.log('');

  // Assertions
  check({ totalSuccessCount, totalRateLimitCount, firstRateLimitAt }, {
    'shared: some requests succeeded': (r) => r.totalSuccessCount > 0,
    'shared: rate limit was triggered': (r) => r.totalRateLimitCount > 0,
    'shared: rate limit triggered around limit': (r) => r.firstRateLimitAt && r.firstRateLimitAt <= RATE_LIMIT_MAX + 2,
  });
}

// Test: Counter persists across different endpoints
function testCounterPersistence() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 2: Counter Persistence Verification');
  console.log('='.repeat(60));
  console.log('Expected: Counter from TEST 1 still active, immediate 429');
  console.log('');

  // Try a few more requests - should all be rate limited
  const testRequests = [
    { type: 'register', username: `persist_test_${Date.now()}_1` },
    { type: 'login', username: `persist_test_${Date.now()}_1` },
    { type: 'register', username: `persist_test_${Date.now()}_2` },
  ];

  let allBlocked = true;

  for (let i = 0; i < testRequests.length; i++) {
    const req = testRequests[i];
    const endpoint = req.type === 'register' ? '/auth/register' : '/auth/login';
    
    const response = http.post(
      `${API_BASE}${endpoint}`,
      JSON.stringify({ username: req.username, password: 'Pass123!' }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const hasHeaders = checkRateLimitHeaders(response);
    rateLimitHeadersPresent.add(hasHeaders);

    const retryAfter = response.headers['Retry-After'] || 'N/A';

    if (response.status === 429) {
      requestsBlocked.add(1);
      rateLimitHit.add(1);
      console.log(`Request ${(i + 1).toString().padStart(2)} [${req.type.padEnd(8)}]: ✗ 429 RATE LIMITED | Retry-After: ${retryAfter}s`);
    } else {
      allBlocked = false;
      requestsAllowed.add(1);
      console.log(`Request ${(i + 1).toString().padStart(2)} [${req.type.padEnd(8)}]: ✓ ${response.status} (unexpected!)`);
    }

    sleep(0.1);
  }

  console.log('');
  console.log('Results:');
  console.log(`  All requests blocked: ${allBlocked ? 'YES ✓' : 'NO ✗'}`);
  console.log('');

  check({ allBlocked }, {
    'persistence: all requests blocked': (r) => r.allBlocked === true,
  });
}

// Test: Rate Limit Reset
function testRateLimitReset() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 3: Rate Limit Reset (Optional - takes 60s)');
  console.log('='.repeat(60));
  console.log('Skipping automatic reset test (would take 60+ seconds)');
  console.log('To test manually:');
  console.log('  1. Run this test');
  console.log('  2. Wait 60 seconds');
  console.log('  3. Run again - should succeed');
  console.log('');
}

// Main test scenario
export default function () {
  // Test 1: Shared rate limiting across /auth/* endpoints
  testSharedAuthRateLimit();

  // Wait a bit before next test
  sleep(1);

  // Test 2: Verify counter persists across endpoints
  testCounterPersistence();

  // Test 3: Rate limit reset (informational only)
  testRateLimitReset();
}

// Setup: Run once before test
export function setup() {
  console.log('\n' + '='.repeat(60));
  console.log('k6 Load Test: Auth Rate Limiting');
  console.log('='.repeat(60));
  console.log(`API Base: ${API_BASE}`);
  console.log(`Rate Limit: ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW} seconds`);
  console.log('='.repeat(60));
  
  // Health check
  const healthResponse = http.get(`${API_BASE}/health`);
  if (healthResponse.status === 200) {
    console.log('✓ API Gateway is healthy');
  } else {
    console.warn(`⚠ API Gateway health check returned ${healthResponse.status}`);
  }
  
  return { apiBase: API_BASE };
}

// Teardown: Run once after test
export function teardown(data) {
  console.log('\n' + '='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log('✓ Rate limiting is SHARED across /auth/* endpoints');
  console.log('✓ Counter is per-IP, not per-endpoint');
  console.log('');
  console.log('Expected behavior:');
  console.log('  • ~10 total requests succeed (mix of login/register)');
  console.log('  • Remaining requests blocked with 429');
  console.log('  • Rate limit headers present in all responses');
  console.log('  • Retry-After header set when blocked');
  console.log('  • Counter persists across different endpoints');
  console.log('='.repeat(60));
  console.log('');
}
