const pino = require('pino');

// Cấu hình pino cơ bản
const logger = pino({
  // level: process.env.LOG_LEVEL || 'info', // Sẽ dùng config ở bước sau
  level: 'info',
  formatters: {
    // Chuẩn hóa tên trường 'level'
    level: (label) => ({ level: label }),
  },
  // Dùng ISO time thay vì epoch time
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;