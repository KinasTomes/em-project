// Sẽ được triển khai chi tiết ở Tuần 2
// Tạm thời chúng ta export các hàm rỗng để các service có thể import

async function connect() {
  console.log('TODO: [Broker] Connecting to RabbitMQ...');
  // Logic kết nối thật sẽ ở đây
}

async function publish(queueName, message) {
  console.log(`TODO: [Broker] Publishing to ${queueName}`, message);
}

async function consume(queueName, handler) {
  console.log(`TODO: [Broker] Consuming from ${queueName}`);
}

module.exports = {
  connect,
  publish,
  consume,
};