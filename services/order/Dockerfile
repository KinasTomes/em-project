# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Install pnpm globally
RUN npm install -g pnpm@10.20.0

# Set the working directory to /app
WORKDIR /app

# Copy package.json and pnpm-lock.yaml to the container
COPY package.json pnpm-lock.yaml* ./

# Install app dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the application files to the container
COPY . .

# Set the command to start the app
CMD [ "pnpm", "start" ]