const jwt = require("jsonwebtoken");
const config = require("../config");
const logger = require("@ecommerce/logger");

/**
 * Middleware to verify JWT token
 */
function isAuthenticated(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Unauthorized - No token provided" });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      req.user = decoded;
      next();
    } catch (err) {
      logger.error(
        `[Auth Middleware] Token verification failed: ${err.message}`
      );
      return res.status(401).json({ message: "Unauthorized - Invalid token" });
    }
  } catch (error) {
    logger.error(`[Auth Middleware] Error: ${error.message}`);
    return res.status(500).json({ message: "Internal server error" });
  }
}

module.exports = { isAuthenticated };
