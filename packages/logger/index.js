// packages/logger/index.js
const pino = require('pino');
const { trace, context } = require('@opentelemetry/api');

// Cấu hình pino-pretty khi ở môi trường dev
const transport =
  process.env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: transport,
  
  // Đây là phần quan trọng!
  // mixin() là một hàm được gọi mỗi khi ghi log
  // Nó cho phép ta thêm "trường" (field) động vào JSON log
  mixin() {
    // 1. Lấy span đang hoạt động từ OTel context
    const span = trace.getSpan(context.active());

    if (!span) {
      return {}; // Không có span, trả về object rỗng
    }

    // 2. Lấy thông tin trace từ span
    const spanContext = span.spanContext();

    // 3. Trả về các trường sẽ được thêm vào log
    return {
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
    };
  },
});

module.exports = logger;