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

# Copy shared packages source code AFTER install so pnpm can create proper workspace links
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY packages/message-broker ./packages/message-broker
COPY packages/tracing ./packages/tracing

# Stage 2: Build the final service image
FROM node:18-alpine

# Install pnpm
RUN npm install -g pnpm@10.20.0

WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml .
COPY package.json .
COPY pnpm-lock.yaml .

# Copy the installed dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy shared packages from deps stage
COPY --from=deps /app/packages ./packages

# Copy api-gateway service files
COPY services/api-gateway ./services/api-gateway

# Set working directory back to root for pnpm workspace
WORKDIR /app

# Run pnpm install again to create symlinks for workspace packages
RUN pnpm install --frozen-lockfile

# Set the command to start the api-gateway service using pnpm filter
CMD [ "pnpm", "--filter", "@ecommerce/api-gateway", "start" ]