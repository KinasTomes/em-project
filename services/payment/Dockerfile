# Stage 1: Install all dependencies
FROM node:18-alpine AS deps

# Install pnpm
RUN npm install -g pnpm@10.20.0

WORKDIR /app

# Copy dependency definition files
COPY pnpm-workspace.yaml .
COPY .npmrc .
COPY package.json .

# Copy all package.json files from shared packages and services needed for install
COPY packages/metrics/package.json ./packages/metrics/
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY packages/message-broker/package.json ./packages/message-broker/
COPY packages/outbox-pattern/package.json ./packages/outbox-pattern/
COPY packages/tracing/package.json ./packages/tracing/
COPY services/payment/package.json ./services/payment/

# Copy the lockfile
COPY pnpm-lock.yaml .

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy shared packages source
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY packages/message-broker ./packages/message-broker
COPY packages/outbox-pattern ./packages/outbox-pattern
COPY packages/tracing ./packages/tracing
COPY packages/metrics ./packages/metrics/

# Stage 2: final runtime image
FROM node:18-alpine

RUN npm install -g pnpm@10.20.0

WORKDIR /app

COPY pnpm-workspace.yaml .
COPY package.json .
COPY pnpm-lock.yaml .

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy workspace packages
COPY --from=deps /app/packages ./packages

# Copy payment service source
COPY services/payment ./services/payment

WORKDIR /app

# Re-link workspace deps
RUN pnpm install --frozen-lockfile

CMD ["pnpm", "--filter", "@ecommerce/payment", "start"]

