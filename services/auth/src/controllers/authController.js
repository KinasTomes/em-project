const AuthService = require("../services/authService");
const logger = require("@ecommerce/logger");
const { recordRegistration } = require("../metrics");

/**
 * Class to encapsulate the logic for the auth routes
 */

class AuthController {
  constructor() {
    this.authService = new AuthService();
  }

  async login(req, res) {
    const { username, password } = req.body;

    const result = await this.authService.login(username, password);

    if (result.success) {
      res.json({ token: result.token });
    } else {
      res.status(400).json({ message: result.message });
    }
  }

  async register(req, res) {
    const user = req.body;
  
    try {
      const existingUser = await this.authService.findUserByUsername(user.username);
  
      if (existingUser) {
        logger.warn({ username: user.username }, "Registration failed: username already taken");
        recordRegistration('duplicate_username');
        throw new Error("Username already taken");
      }
  
      const result = await this.authService.register(user);
      res.json(result);
    } catch (err) {
      // Only record 'failed' if it's not a duplicate username error
      if (err.message !== "Username already taken") {
        recordRegistration('failed');
      }
      res.status(400).json({ message: err.message });
    }
  }

  async getProfile(req, res) {
    const userId = req.user.id;

    try {
      const user = await this.authService.getUserById(userId);
      res.json(user);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  }
}

module.exports = AuthController;
