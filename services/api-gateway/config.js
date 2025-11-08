const sharedConfig = require('@ecommerce/config');

module.exports = {
    port: sharedConfig.getPort(3003),
    authServiceUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
    productServiceUrl: process.env.PRODUCT_SERVICE_URL || 'http://localhost:3004',
    orderServiceUrl: process.env.ORDER_SERVICE_URL || 'http://localhost:3002',
};
