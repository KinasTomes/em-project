const sharedConfig = require("@ecommerce/config");

module.exports = {
  mongoURI: sharedConfig.getMongoURI("inventory"),
  rabbitMQURI: sharedConfig.getRabbitMQUrl(),
  rabbitMQQueue: "inventory",
  port: sharedConfig.getPort(3005),
  jwtSecret:
    process.env.JWT_SECRET ||
    "a-very-long-and-secure-secret-key-for-jwt-32-chars",
};
