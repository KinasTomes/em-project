# Stage 1: Install all dependencies
FROM node:18-alpine AS deps

# Install pnpm
RUN npm install -g pnpm@10.20.0

WORKDIR /app

# Copy dependency definition files
COPY pnpm-workspace.yaml .
COPY .npmrc .
COPY package.json .

# Copy all package.json files from shared packages and services
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY packages/message-broker/package.json ./packages/message-broker/
COPY packages/tracing/package.json ./packages/tracing/
COPY services/api-gateway/package.json ./services/api-gateway/
COPY services/auth/package.json ./services/auth/
COPY services/order/package.json ./services/order/
COPY services/product/package.json ./services/product/

# Copy the lockfile
COPY pnpm-lock.yaml .

# Install all dependencies for the entire monorepo
# This leverages Docker caching, as this layer only changes when dependencies change.
RUN pnpm install --frozen-lockfile

# Stage 2: Build the final service image
FROM node:18-alpine

# Install pnpm
RUN npm install -g pnpm@10.20.0

WORKDIR /app

# Copy the installed dependencies from the 'deps' stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/services/auth ./

# Copy the service's source code
COPY services/auth/src ./src
COPY services/auth/index.js .
COPY services/auth/package.json .

# Set the command to start the app
CMD [ "pnpm", "start" ]
