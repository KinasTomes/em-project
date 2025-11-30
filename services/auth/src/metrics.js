/**
 * Auth Service - Business Metrics
 * 
 * Metrics specific to authentication operations
 */

const { promClient } = require('@ecommerce/metrics');

// Login attempts counter
const loginAttempts = new promClient.Counter({
  name: 'auth_login_attempts_total',
  help: 'Total login attempts',
  labelNames: ['status'] // success, failed_password, user_not_found
});

// Registration counter
const registrations = new promClient.Counter({
  name: 'auth_registrations_total',
  help: 'Total user registrations',
  labelNames: ['status'] // success, failed, duplicate_username
});

// Token operations counter
const tokenOperations = new promClient.Counter({
  name: 'auth_token_operations_total',
  help: 'Token operations',
  labelNames: ['operation', 'status'] // operation: issue, verify, refresh; status: success, failed
});

// Active tokens gauge (approximation based on issued - expired)
const activeTokens = new promClient.Gauge({
  name: 'auth_active_tokens',
  help: 'Number of active tokens (approximation based on tokens issued in last 24h)'
});

// Password hash duration histogram
const passwordHashDuration = new promClient.Histogram({
  name: 'auth_password_hash_duration_seconds',
  help: 'Duration of password hashing operations',
  labelNames: ['operation'], // hash, compare
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

// User count gauge
const userCount = new promClient.Gauge({
  name: 'auth_users_total',
  help: 'Total number of registered users'
});

/**
 * Record a login attempt
 * @param {'success'|'failed_password'|'user_not_found'} status 
 */
function recordLoginAttempt(status) {
  loginAttempts.inc({ status });
}

/**
 * Record a registration attempt
 * @param {'success'|'failed'|'duplicate_username'} status 
 */
function recordRegistration(status) {
  registrations.inc({ status });
}

/**
 * Record a token operation
 * @param {'issue'|'verify'|'refresh'} operation 
 * @param {'success'|'failed'} status 
 */
function recordTokenOperation(operation, status) {
  tokenOperations.inc({ operation, status });
  
  // Track active tokens approximation
  if (operation === 'issue' && status === 'success') {
    activeTokens.inc();
  }
}

/**
 * Start a timer for password hash operation
 * @param {'hash'|'compare'} operation 
 * @returns {function} End timer function
 */
function startPasswordHashTimer(operation) {
  return passwordHashDuration.startTimer({ operation });
}

/**
 * Update total user count
 * @param {number} count 
 */
function setUserCount(count) {
  userCount.set(count);
}

/**
 * Decrement active tokens (called when tokens expire)
 */
function decrementActiveTokens() {
  activeTokens.dec();
}

module.exports = {
  // Metrics
  loginAttempts,
  registrations,
  tokenOperations,
  activeTokens,
  passwordHashDuration,
  userCount,
  
  // Helper functions
  recordLoginAttempt,
  recordRegistration,
  recordTokenOperation,
  startPasswordHashTimer,
  setUserCount,
  decrementActiveTokens
};
