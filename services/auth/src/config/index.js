const sharedConfig = require("@ecommerce/config");

module.exports = {
  mongoURI: sharedConfig.getMongoURI('auth'),
  jwtSecret: sharedConfig.JWT_SECRET,
  port: sharedConfig.getPort(3000),
};
