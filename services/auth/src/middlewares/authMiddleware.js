const jwt = require("jsonwebtoken");
const config = require("../config");
const { recordTokenOperation } = require("../metrics");

/**
 * Middleware to verify the token
 * Supports both x-auth-token header and Authorization Bearer token
 * Priority: x-auth-token > Authorization
 */

module.exports = function(req, res, next) {
  // Try x-auth-token first (higher priority)
  let token = req.header("x-auth-token");
  
  // If not found, try Authorization header
  if (!token) {
    const authHeader = req.header("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7); // Remove "Bearer " prefix
    }
  }

  if (!token) {
    recordTokenOperation('verify', 'failed');
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;
    recordTokenOperation('verify', 'success');
    next();
  } catch (e) {
    recordTokenOperation('verify', 'failed');
    res.status(400).json({ message: "Token is not valid" });
  }
};
