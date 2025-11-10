const sharedConfig = require("@ecommerce/config");

module.exports = {
  mongoURI: sharedConfig.getMongoURI("inventory"),
  rabbitMQURI: sharedConfig.getRabbitMQUrl(),
  rabbitMQQueue: "inventory",
  port: sharedConfig.getPort(3005),
  // Align JWT secret with shared configuration to keep services in sync
  jwtSecret: sharedConfig.JWT_SECRET,
};
