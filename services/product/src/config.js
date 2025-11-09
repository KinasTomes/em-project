const fs = require("fs");

const DEFAULT_PORT = 3004;

if (!process.env.PORT) {
  if (process.env.PRODUCT_PORT) {
    process.env.PORT = process.env.PRODUCT_PORT;
  } else {
    process.env.PORT = String(DEFAULT_PORT);
  }
}

const sharedConfig = require("@ecommerce/config");

const isDockerRuntime = (() => {
  if (
    process.env.RUNNING_IN_DOCKER === "true" ||
    process.env.NODE_ENV === "production"
  ) {
    return true;
  }
  try {
    return fs.existsSync("/.dockerenv");
  } catch (err) {
    return false;
  }
})();
const DEFAULT_LOCAL_MONGO =
  "mongodb://root:example@localhost:27018/productDB?authSource=admin";
const DEFAULT_DOCKER_MONGO =
  "mongodb://root:example@mongo_product:27017/productDB?authSource=admin";
const DEFAULT_LOCAL_RABBIT = "amqp://guest:guest@localhost:5672";
const DEFAULT_DOCKER_RABBIT = "amqp://guest:guest@rabbitmq:5672";

const normalizeHost = (uri, dockerHost, dockerPort, fallback) => {
  if (!uri) return fallback;
  if (!isDockerRuntime) return uri;

  const hostPattern =
    /(mongodb:\/\/[^@]*@|mongodb:\/\/)(\[::1\]|localhost|127\.0\.0\.1)(:\d+)?/i;
  if (hostPattern.test(uri)) {
    return uri.replace(
      hostPattern,
      (_match, prefix) => `${prefix}${dockerHost}:${dockerPort}`
    );
  }

  return uri;
};

const normalizeAmqpHost = (uri, dockerHost, dockerPort, fallback) => {
  if (!uri) return fallback;
  if (!isDockerRuntime) return uri;

  const hostPattern =
    /(amqps?:\/\/[^@]*@|amqps?:\/\/)(\[::1\]|localhost|127\.0\.0\.1)(:\d+)?/i;
  if (hostPattern.test(uri)) {
    return uri.replace(
      hostPattern,
      (_match, prefix) => `${prefix}${dockerHost}:${dockerPort}`
    );
  }

  return uri;
};

const rawMongoURI =
  process.env.MONGODB_PRODUCT_URI ||
  sharedConfig.MONGODB_PRODUCT_URI ||
  (sharedConfig.getMongoURI ? sharedConfig.getMongoURI("product") : null) ||
  (isDockerRuntime ? DEFAULT_DOCKER_MONGO : DEFAULT_LOCAL_MONGO);

const mongoURI = normalizeHost(
  rawMongoURI,
  "mongo_product",
  "27017",
  isDockerRuntime ? DEFAULT_DOCKER_MONGO : DEFAULT_LOCAL_MONGO
);

const rawRabbitURI =
  process.env.RABBITMQ_URL ||
  sharedConfig.RABBITMQ_URL ||
  (sharedConfig.getRabbitMQUrl ? sharedConfig.getRabbitMQUrl() : null) ||
  (isDockerRuntime ? DEFAULT_DOCKER_RABBIT : DEFAULT_LOCAL_RABBIT);

const rabbitMQURI = normalizeAmqpHost(
  rawRabbitURI,
  "rabbitmq",
  "5672",
  isDockerRuntime ? DEFAULT_DOCKER_RABBIT : DEFAULT_LOCAL_RABBIT
);

const port = Number(process.env.PORT || DEFAULT_PORT);

module.exports = {
  port,
  mongoURI,
  rabbitMQURI,
  exchangeName: "products",
  queueName: "products_queue",
};
