# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Install pnpm globally
RUN npm install -g pnpm@10.20.0

# Set the working directory to /app
WORKDIR /app

# Copy pnpm-lock.yaml from root and package.json from service
COPY pnpm-lock.yaml ./
COPY services/api-gateway/package.json ./

# Install app dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the application files to the container
COPY services/api-gateway/ .

# Set the command to start the app
CMD [ "pnpm", "start" ]
