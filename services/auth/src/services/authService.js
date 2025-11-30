const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const UserRepository = require("../repositories/userRepository");
const config = require("../config");
const User = require("../models/user");
const {
  recordLoginAttempt,
  recordRegistration,
  recordTokenOperation,
  startPasswordHashTimer,
  setUserCount
} = require("../metrics");

/**
 * Class to hold the business logic for the auth service interacting with the user repository
 */
class AuthService {
  constructor() {
    this.userRepository = new UserRepository();
  }

  async findUserByUsername(username) {
    const user = await User.findOne({ username });
    return user;
  }

  async login(username, password) {
    const user = await this.userRepository.getUserByUsername(username);

    if (!user) {
      recordLoginAttempt('user_not_found');
      return { success: false, message: "Invalid username or password" };
    }

    // Time password comparison
    const endTimer = startPasswordHashTimer('compare');
    const isMatch = await bcrypt.compare(password, user.password);
    endTimer();

    if (!isMatch) {
      recordLoginAttempt('failed_password');
      return { success: false, message: "Invalid username or password" };
    }

    const token = jwt.sign(
      { id: user._id, username: user.username },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    // Record successful login and token issue
    recordLoginAttempt('success');
    recordTokenOperation('issue', 'success');

    return { success: true, token };
  }

  async register(user) {
    // Time password hashing
    const endTimer = startPasswordHashTimer('hash');
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(user.password, salt);
    endTimer();

    const result = await this.userRepository.createUser(user);
    
    // Record successful registration
    recordRegistration('success');
    
    // Update total user count
    const totalUsers = await User.countDocuments();
    setUserCount(totalUsers);

    return result;
  }

  async deleteTestUsers() {
    // Delete all users with a username that starts with "test"
    await User.deleteMany({ username: /^test/ });
  }
}

module.exports = AuthService;
