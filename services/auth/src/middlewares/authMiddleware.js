const logger = require("@ecommerce/logger");
const { recordTokenOperation } = require("../metrics");

/**
 * Authentication middleware - trusts API Gateway
 * 
 * API Gateway đã verify JWT và set các headers:
 * - x-user-id: User ID từ token
 * - x-user-email: Email (optional)
 * - x-user-role: Role (optional)
 * - x-auth-verified: 'true' nếu đã verify
 */
module.exports = function(req, res, next) {
  const userId = req.headers["x-user-id"];

  if (!userId) {
    logger.warn({ path: req.path }, "Unauthorized - Missing X-User-ID header");
    recordTokenOperation('verify', 'failed');
    return res.status(401).json({ message: "No authorization, access denied" });
  }

  // Attach user info to request
  req.user = {
    userId,
    email: req.headers["x-user-email"] || "",
    role: req.headers["x-user-role"] || "user",
  };

  recordTokenOperation('verify', 'success');
  next();
};
