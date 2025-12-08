# 🛍️ E-Commerce Microservices Platform

> Kiến trúc microservices hiện đại cho hệ thống thương mại điện tử, sử dụng Node.js, Express, MongoDB, RabbitMQ và Docker.

[![pnpm](https://img.shields.io/badge/pnpm-10.20.0-yellow)](https://pnpm.io/)
[![Node](https://img.shields.io/badge/node-18.x-green)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-compose-blue)](https://docs.docker.com/compose/)

## 📋 Mục lục

- [Tổng quan](#-tổng-quan)
- [Kiến trúc hệ thống](#-kiến-trúc-hệ-thống)
- [Cấu trúc dự án](#-cấu-trúc-dự-án)
- [Các microservices](#-các-microservices)
- [Công nghệ sử dụng](#-công-nghệ-sử-dụng)
- [Bắt đầu](#-bắt-đầu)
- [Phát triển](#-phát-triển)
- [API Documentation](#-api-documentation)
- [Roadmap](#-roadmap)

---

## 🎯 Tổng quan

Đây là một hệ thống **microservices** hoàn chỉnh cho nền tảng thương mại điện tử, được tổ chức dưới dạng **monorepo** với **pnpm workspaces**. Dự án tuân theo các nguyên tắc:

- ✅ **Clean Architecture** - Kiến trúc phân lớp rõ ràng (Controllers, Services, Repositories, Models)
- ✅ **Shared Packages** - Code dùng chung được tách thành các package riêng
- ✅ **Strict Validation** - Environment variables được validate với Zod ngay khi khởi động
- ✅ **Event-Driven** - Giao tiếp bất đồng bộ qua RabbitMQ
- ✅ **Docker-first** - Dễ dàng triển khai và scale với Docker Compose
- ✅ **Production-Ready** - Security checks và fail-fast error handling

---

## 📂 Cấu trúc dự án

```
em-project/
├── packages/                    # Shared packages (workspace)
│   └── config/                  # @ecommerce/config - Cấu hình chung
│       ├── index.js
│       └── package.json
│
├── services/                    # Microservices
│   ├── api-gateway/            # @ecommerce/api-gateway
│   │   ├── Dockerfile
│   │   ├── index.js
│   │   └── package.json
│   │
│   ├── auth/                   # @ecommerce/auth
│   │   ├── Dockerfile
│   │   ├── index.js
│   │   ├── package.json
│   │   └── src/
│   │       ├── app.js
│   │       ├── config/
│   │       ├── controllers/
│   │       ├── middlewares/
│   │       ├── models/
│   │       ├── repositories/
│   │       ├── services/
│   │       └── test/
│   │
│   ├── product/                # @ecommerce/product
│   │   ├── Dockerfile
│   │   ├── index.js
│   │   ├── package.json
│   │   └── src/
│   │       ├── app.js
│   │       ├── config.js
│   │       ├── controllers/
│   │       ├── models/
│   │       ├── repositories/
│   │       ├── routes/
│   │       ├── services/
│   │       ├── test/
│   │       └── utils/
│   │
│   └── order/                  # @ecommerce/order
│       ├── Dockerfile
│       ├── index.js
│       ├── package.json
│       └── src/
│           ├── app.js
│           ├── config.js
│           ├── models/
│           └── utils/
│
├── docker-compose.yml          # Orchestration
├── pnpm-workspace.yaml         # pnpm workspace config
├── pnpm-lock.yaml             # Lockfile chung
├── .npmrc                      # pnpm configuration
├── .dockerignore              # Docker ignore rules
├── package.json               # Root package
└── README.md                   # This file
```

---

## 🔧 Các Microservices

### 1️⃣ **API Gateway** (`:3003`)
**Vai trò:** Điểm vào duy nhất cho toàn bộ hệ thống, định tuyến requests đến các service tương ứng.

**Công nghệ:** Express.js, http-proxy

**Endpoints:**
- `/auth/*` → Auth Service
- `/products/*` → Product Service
- `/orders/*` → Order Service

---

### 2️⃣ **Auth Service** (`:3000`)
**Vai trò:** Quản lý xác thực người dùng, đăng ký, đăng nhập, JWT tokens.

**Công nghệ:** Express.js, MongoDB, bcryptjs, jsonwebtoken

**Kiến trúc:**
```
Controllers → Services → Repositories → Models (Mongoose)
```

**API Endpoints:**
```http
POST   /auth/register          # Đăng ký user mới
POST   /auth/login             # Đăng nhập, nhận JWT token
GET    /auth/dashboard         # Protected route (cần token)
```

**Cấu trúc layered:**
- `authController.js` - Xử lý HTTP requests
- `authService.js` - Business logic (hash password, generate token)
- `userRepository.js` - Data access layer
- `user.js` - Mongoose model
- `authMiddleware.js` - JWT verification

---

### 3️⃣ **Product Service** (`:3001`)
**Vai trò:** Quản lý sản phẩm (CRUD), publish events qua RabbitMQ.

**Công nghệ:** Express.js, MongoDB, RabbitMQ (amqplib)

**Kiến trúc:**
```
Routes → Controllers → Services → Repositories → Models
                ↓
         MessageBroker (RabbitMQ)
```

**API Endpoints:**
```http
GET    /api/v1/product         # Lấy danh sách sản phẩm
GET    /api/v1/product/:id     # Lấy 1 sản phẩm
POST   /api/v1/product         # Tạo sản phẩm (protected)
```

**Events:**
- Publish: `product.created`, `product.updated`

---

### 4️⃣ **Order Service** (`:3002`)
**Vai trò:** Quản lý đơn hàng, consume events từ RabbitMQ.

**Công nghệ:** Express.js, MongoDB, RabbitMQ

**API Endpoints:**
```http
POST   /api/v1/order           # Tạo đơn hàng (protected)
GET    /api/v1/order/:id       # Lấy thông tin đơn hàng
```

**Events:**
- Consume: `product.*`, `order.*`

---

## 🛠️ Công nghệ sử dụng

| Công nghệ | Mục đích |
|-----------|----------|
| **Node.js 18** | Runtime |
| **Express.js** | Web framework |
| **MongoDB** | Database (mỗi service 1 DB riêng) |
| **Mongoose** | ODM cho MongoDB |
| **RabbitMQ** | Message broker |
| **JWT** | Authentication tokens |
| **bcryptjs** | Password hashing |
| **pnpm** | Package manager (workspace) |
| **Docker** | Containerization |
| **Docker Compose** | Orchestration |
| **Mocha + Chai** | Testing framework |

---

## 🚀 Bắt đầu

### Yêu cầu hệ thống

- **Node.js** >= 18.x
- **pnpm** >= 10.20.0
- **Docker** & **Docker Compose**

### Cài đặt

```bash
# 1. Clone repository
git clone https://github.com/KinasTomes/em-project.git
cd em-project

# 2. Cài đặt dependencies (cho tất cả workspaces)
pnpm install
```

### Cấu hình Environment Variables

Tạo một file `.env` ở thư mục gốc của dự án bằng cách sao chép từ file `.env.example`.

```bash
# Copy the template to create your own environment file
cp .env.example .env

# You can now edit the .env file if you need to change default ports or secrets
nano .env
```

File `.env` ở gốc sẽ được tự động sử dụng bởi tất cả các services khi chạy bằng Docker Compose.

### Chạy với Docker (Recommended)

Phương pháp này sẽ khởi chạy toàn bộ hệ thống, bao gồm tất cả các microservices, databases, RabbitMQ và Jaeger để tracing.

```bash   
# Build và chạy toàn bộ hệ thống ở chế độ nền
docker compose up --build -d

# Xem logs từ tất cả các container
docker compose logs -f

# Để xem log của một service cụ thể (ví dụ: auth)
docker compose logs -f auth

# Dừng và xóa toàn bộ container, network và volume
docker compose down -v
```

**Các services sẽ có thể truy cập tại:**
- **API Gateway**: http://localhost:3003
- **Auth Service**: http://localhost:3000
- **Product Service**: http://localhost:3001
- **Order Service**: http://localhost:3002
- **RabbitMQ Management**: http://localhost:15672 (user: `guest`, pass: `guest`)
- **Jaeger UI (Tracing)**: http://localhost:16686

### Chạy local (Development)

Nếu bạn muốn chạy code của các service trên máy local (ví dụ để debug) nhưng vẫn sử dụng các infrastructure (DBs, RabbitMQ) từ Docker.

```bash
# 1. Chỉ khởi chạy các infrastructure services
docker compose up -d mongo_auth mongo_product mongo_order rabbitmq jaeger

# 2. Chạy các service của bạn ở các terminal riêng biệt
# Terminal 1 - Auth
pnpm dev:auth

# Terminal 2 - Product
pnpm dev:product

# Terminal 3 - Order
pnpm dev:order

# Terminal 4 - Gateway
pnpm dev:gateway
```

---

## 💻 Phát triển

### Scripts có sẵn

```bash
# Ở thư mục root
pnpm install              # Cài đặt tất cả dependencies
pnpm dev:auth            # Chạy auth service
pnpm dev:gateway         # Chạy api-gateway
pnpm dev:order           # Chạy order service
pnpm dev:product         # Chạy product service
pnpm dev:all             # Chạy tất cả services song song
pnpm test                # Chạy tất cả tests

# Ở từng service
cd services/auth
pnpm start               # Chạy service
pnpm test                # Chạy tests
```

### Thêm dependency mới

```bash
# Thêm dependency cho service cụ thể
pnpm add express --filter @ecommerce/auth

# Thêm vào shared package
pnpm add lodash --filter @ecommerce/config

# Thêm dev dependency cho tất cả
pnpm add -D eslint -w
```

### Tạo service mới

```bash
# 1. Tạo thư mục trong services/
mkdir -p services/payment/src

# 2. Tạo package.json
cd services/payment
pnpm init

# 3. Đổi tên package thành @ecommerce/payment

# 4. Thêm dependency
pnpm add express @ecommerce/config

# 5. Cập nhật pnpm-workspace.yaml (đã auto-detect)

# 6. Tạo Dockerfile (copy từ service khác)

# 7. Thêm vào docker-compose.yml
```

---

## 📖 API Documentation

### Authentication Flow

```http
# 1. Đăng ký user mới
POST http://localhost:3003/auth/register
Content-Type: application/json

{
  "username": "testuser",
  "password": "password123"
}

# Response: 201 Created
{
  "message": "User created successfully"
}

# 2. Đăng nhập
POST http://localhost:3003/auth/login
Content-Type: application/json

{
  "username": "testuser",
  "password": "password123"
}

# Response: 200 OK
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}

# 3. Truy cập protected route
GET http://localhost:3003/auth/dashboard
Authorization: Bearer <token>

# Response: 200 OK
{
  "message": "Welcome to the dashboard"
}
```

### Product API

```http
# Lấy danh sách sản phẩm
GET http://localhost:3003/products/api/v1/product

# Tạo sản phẩm mới (cần auth)
POST http://localhost:3003/products/api/v1/product
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "iPhone 15",
  "price": 999,
  "description": "Latest iPhone"
}
```

### Order API

```http
# Tạo đơn hàng (cần auth)
POST http://localhost:3003/orders/api/v1/order
Authorization: Bearer <token>
Content-Type: application/json

{
  "items": [
    {
      "productId": "product_id_here",
      "quantity": 2
    }
  ]
}
```

---

## 👥 Authors

- **KinasTomes** - [GitHub](https://github.com/KinasTomes)

---

## Testing
- Flow: Register → Login → POST /orders → Order PENDING → Outbox created → RabbitMQ publish → Inventory process → Order CONFIRMED
node tests/e2e-order-flow.js

- Flow: Register → Login → POST /orders → Order PENDING → Outbox created → RabbitMQ publish → Inventory process → Order CANCELLED
node tests/e2e-order-cancelled.js

**📌 Quick Links:**
- [Project Plan](./PLAN.md) - Kế hoạch chi tiết 4 tuần
- [Old README](./OLD_README.md) - Tài liệu cũ (legacy)
- [Docker Docs](https://docs.docker.com/)
- [pnpm Docs](https://pnpm.io/)
