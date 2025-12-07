# 🚀 Hướng dẫn Deploy E-Commerce Microservices

Tài liệu này hướng dẫn chi tiết cách deploy hệ thống lên Google Cloud VM.

---

## 📋 Mục lục

1. [Option A: Deploy 1 VM (Đơn giản)](#option-a-deploy-1-vm-đơn-giản)
2. [Option B: Deploy 3 VMs (Distributed)](#option-b-deploy-3-vms-distributed)
3. [Setup MongoDB Atlas](#setup-mongodb-atlas)
4. [Quản lý & Monitoring](#quản-lý--monitoring)
5. [Troubleshooting](#troubleshooting)

---

# Option A: Deploy 1 VM (Đơn giản)

> **Phù hợp cho:** Dev/Test, demo, < 100 users đồng thời

## 1. Cấu hình VM khuyến nghị

| Spec         | Giá trị                       | Chi phí/tháng  |
| ------------ | ----------------------------- | -------------- |
| Machine Type | `e2-standard-2`               | ~$50           |
| vCPU         | 2                             |                |
| RAM          | 8GB                           |                |
| Disk         | 50GB SSD                      | ~$8            |
| OS           | Ubuntu 22.04 LTS              |                |
| Region       | `asia-southeast1` (Singapore) |                |
| **Total**    |                               | **~$60/tháng** |

## 2. Tạo VM trên Google Cloud Console

### 2.1 Vào GCP Console

```
https://console.cloud.google.com
```

### 2.2 Tạo VM Instance

1. **Compute Engine** → **VM Instances** → **Create Instance**
2. Điền thông tin:

| Setting      | Value                                       |
| ------------ | ------------------------------------------- |
| Name         | `ecommerce-vm`                              |
| Region       | `asia-southeast1`                           |
| Zone         | `asia-southeast1-a`                         |
| Machine type | `e2-standard-2` (2 vCPU, 8GB)               |
| Boot disk    | Click "Change" → Ubuntu 22.04 LTS, 50GB SSD |
| Firewall     | ✅ Allow HTTP traffic                       |
| Firewall     | ✅ Allow HTTPS traffic                      |

3. Click **Create**

### 2.3 Mở thêm ports (Firewall Rules)

**VPC Network** → **Firewall** → **Create Firewall Rule**

| Field               | Value                        |
| ------------------- | ---------------------------- |
| Name                | `allow-ecommerce-ports`      |
| Targets             | All instances in the network |
| Source IP ranges    | `0.0.0.0/0`                  |
| Protocols and ports | tcp: `3003,15672,16686`      |

> **Giải thích ports:**
>
> - `3003`: API Gateway (bắt buộc)
> - `15672`: RabbitMQ Management UI (optional, chỉ để debug)
> - `16686`: Jaeger Tracing UI (optional, chỉ để debug)

## 3. SSH vào VM và cài đặt

### 3.1 SSH vào VM

```bash
# Cách 1: Click nút "SSH" trên GCP Console

# Cách 2: Dùng gcloud CLI (cần cài trước)
gcloud compute ssh ecommerce-vm --zone=asia-southeast1-a
```

### 3.2 Cài đặt Docker

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Cài Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group (không cần sudo)
sudo usermod -aG docker $USER

# Apply group changes
newgrp docker

# Verify Docker
docker --version
# Output: Docker version 24.x.x
```

### 3.3 Cài đặt Docker Compose

```bash
# Download Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose

# Make executable
sudo chmod +x /usr/local/bin/docker-compose

# Verify
docker-compose --version
# Output: Docker Compose version v2.x.x
```

### 3.4 Clone Project

```bash
# Cài Git
sudo apt install git -y

# Clone project
cd ~
git clone https://github.com/KinasTomes/em-project.git
cd em-project

# Kiểm tra
ls -la
```

## 4. Cấu hình Environment Variables

### 4.1 Tạo file .env

```bash
# Copy từ example
cp .env.example .env

# Edit file
nano .env
```

### 4.2 Nội dung file .env (Production)

```dotenv
#================================================================
# E-COMMERCE MICROSERVICES - PRODUCTION CONFIG
#================================================================

#----------------------------------------------------------------
# 1. GENERAL SETTINGS
#----------------------------------------------------------------
NODE_ENV=production

#----------------------------------------------------------------
# 2. SERVICE PORTS
#----------------------------------------------------------------
API_GATEWAY_PORT=3003
AUTH_PORT=3001
ORDER_PORT=3002
PRODUCT_PORT=3004
INVENTORY_PORT=3005
PAYMENT_PORT=3006
SECKILL_PORT=3007

#----------------------------------------------------------------
# 3. DATABASE (MongoDB)
# Option 1: Dùng MongoDB Atlas (Recommended - xem phần Setup MongoDB Atlas)
# Option 2: Self-hosted trong Docker (như bên dưới)
#----------------------------------------------------------------

# Self-hosted MongoDB (trong docker-compose)
MONGODB_AUTH_URI=mongodb://mongo-auth:27017/authDB
MONGODB_PRODUCT_URI=mongodb://mongo-product:27017/productDB
MONGODB_ORDER_URI=mongodb://mongo-order:27017/orderDB
MONGODB_INVENTORY_URI=mongodb://mongo-inventory:27017/inventoryDB
MONGODB_PAYMENT_URI=mongodb://mongo-payment:27017/paymentDB

# Nếu dùng MongoDB Atlas, thay bằng:
# MONGODB_AUTH_URI=mongodb+srv://username:password@cluster.mongodb.net/authDB?retryWrites=true&w=majority
# MONGODB_PRODUCT_URI=mongodb+srv://username:password@cluster.mongodb.net/productDB?retryWrites=true&w=majority
# MONGODB_ORDER_URI=mongodb+srv://username:password@cluster.mongodb.net/orderDB?retryWrites=true&w=majority
# MONGODB_INVENTORY_URI=mongodb+srv://username:password@cluster.mongodb.net/inventoryDB?retryWrites=true&w=majority
# MONGODB_PAYMENT_URI=mongodb+srv://username:password@cluster.mongodb.net/paymentDB?retryWrites=true&w=majority

#----------------------------------------------------------------
# 4. MESSAGE BROKER & CACHE
#----------------------------------------------------------------
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
REDIS_URL=redis://redis:6379
REDIS_SECKILL_URL=redis://redis-seckill:6380
EXCHANGE_NAME=ecommerce.events

#----------------------------------------------------------------
# 5. SECURITY (⚠️ BẮT BUỘC ĐỔI!)
#----------------------------------------------------------------
# JWT Secret - phải ít nhất 64 ký tự, random
JWT_SECRET=THAY_BANG_CHUOI_RANDOM_64_KY_TU_KHONG_DUOC_DE_MAC_DINH_NAY

# Seckill Admin Key
SECKILL_ADMIN_KEY=THAY_BANG_CHUOI_RANDOM_KHAC

#----------------------------------------------------------------
# 6. OBSERVABILITY
#----------------------------------------------------------------
JAEGER_ENDPOINT=http://jaeger:4318/v1/traces

#----------------------------------------------------------------
# 7. PAYMENT CONFIG
#----------------------------------------------------------------
PAYMENT_SUCCESS_RATE=0.9
```

### 4.3 Generate JWT Secret (Random)

```bash
# Chạy lệnh này để generate random string
openssl rand -base64 48

# Copy output và paste vào JWT_SECRET trong .env
```

### 4.4 Lưu file

```bash
# Trong nano: Ctrl+O để save, Enter để confirm, Ctrl+X để exit
```

## 5. Tạo Docker Compose cho Production

Project đã có sẵn `docker-compose.yml`, nhưng cần thêm MongoDB containers. Tạo file mới:

```bash
nano docker-compose.prod.yml
```

Nội dung:

```yaml
# docker-compose.prod.yml - Single VM Production Setup
version: '3.8'

services:
  #================================================================
  # APPLICATION SERVICES
  #================================================================
  api-gateway:
    build:
      context: .
      dockerfile: ./services/api-gateway/Dockerfile
    ports:
      - '3003:3003'
    environment:
      - NODE_ENV=production
      - PORT=3003
      - AUTH_SERVICE_URL=http://auth:3001
      - PRODUCT_SERVICE_URL=http://product:3004
      - ORDER_SERVICE_URL=http://order:3002
      - INVENTORY_SERVICE_URL=http://inventory:3005
      - SECKILL_SERVICE_URL=http://seckill:3007
      - JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - auth
      - product
      - order
      - inventory
      - seckill
    restart: unless-stopped
    networks:
      - ecommerce-network

  auth:
    build:
      context: .
      dockerfile: ./services/auth/Dockerfile
    ports:
      - '3001:3001'
    environment:
      - NODE_ENV=production
      - PORT=3001
      - MONGODB_AUTH_URI=${MONGODB_AUTH_URI}
      - JWT_SECRET=${JWT_SECRET}
      - JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
    depends_on:
      - mongo-auth
      - jaeger
    restart: unless-stopped
    networks:
      - ecommerce-network

  product:
    build:
      context: .
      dockerfile: ./services/product/Dockerfile
    ports:
      - '3004:3004'
    environment:
      - NODE_ENV=production
      - PORT=3004
      - MONGODB_PRODUCT_URI=${MONGODB_PRODUCT_URI}
      - RABBITMQ_URL=${RABBITMQ_URL}
      - REDIS_URL=${REDIS_URL}
      - INVENTORY_URL=http://inventory:3005
      - JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - mongo-product
      - rabbitmq
      - redis
    restart: unless-stopped
    networks:
      - ecommerce-network

  order:
    build:
      context: .
      dockerfile: ./services/order/Dockerfile
    ports:
      - '3002:3002'
    environment:
      - NODE_ENV=production
      - PORT=3002
      - MONGODB_ORDER_URI=${MONGODB_ORDER_URI}
      - RABBITMQ_URL=${RABBITMQ_URL}
      - REDIS_URL=${REDIS_URL}
      - EXCHANGE_NAME=${EXCHANGE_NAME}
      - PRODUCT_SERVICE_URL=http://product:3004
      - JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - mongo-order
      - rabbitmq
      - redis
    restart: unless-stopped
    networks:
      - ecommerce-network

  inventory:
    build:
      context: .
      dockerfile: ./services/inventory/Dockerfile
    ports:
      - '3005:3005'
    environment:
      - NODE_ENV=production
      - PORT=3005
      - MONGODB_INVENTORY_URI=${MONGODB_INVENTORY_URI}
      - RABBITMQ_URL=${RABBITMQ_URL}
      - REDIS_URL=${REDIS_URL}
      - EXCHANGE_NAME=${EXCHANGE_NAME}
      - JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - mongo-inventory
      - rabbitmq
      - redis
    restart: unless-stopped
    networks:
      - ecommerce-network

  payment:
    build:
      context: .
      dockerfile: ./services/payment/Dockerfile
    ports:
      - '3006:3006'
    environment:
      - NODE_ENV=production
      - PORT=3006
      - PAYMENT_SUCCESS_RATE=${PAYMENT_SUCCESS_RATE:-0.9}
      - MONGODB_PAYMENT_URI=${MONGODB_PAYMENT_URI}
      - RABBITMQ_URL=${RABBITMQ_URL}
      - REDIS_URL=${REDIS_URL}
      - EXCHANGE_NAME=${EXCHANGE_NAME}
      - JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
    depends_on:
      - mongo-payment
      - rabbitmq
      - redis
    restart: unless-stopped
    networks:
      - ecommerce-network

  seckill:
    build:
      context: .
      dockerfile: ./services/seckill/Dockerfile
    ports:
      - '3007:3007'
    environment:
      - NODE_ENV=production
      - PORT=3007
      - RABBITMQ_URL=${RABBITMQ_URL}
      - REDIS_SECKILL_URL=${REDIS_SECKILL_URL}
      - EXCHANGE_NAME=${EXCHANGE_NAME}
      - JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
      - SECKILL_ADMIN_KEY=${SECKILL_ADMIN_KEY}
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - rabbitmq
      - redis-seckill
    restart: unless-stopped
    networks:
      - ecommerce-network

  #================================================================
  # DATABASES (MongoDB - Self-hosted)
  #================================================================
  mongo-auth:
    image: mongo:7
    volumes:
      - mongo-auth-data:/data/db
    restart: unless-stopped
    networks:
      - ecommerce-network

  mongo-product:
    image: mongo:7
    volumes:
      - mongo-product-data:/data/db
    restart: unless-stopped
    networks:
      - ecommerce-network

  mongo-order:
    image: mongo:7
    volumes:
      - mongo-order-data:/data/db
    restart: unless-stopped
    networks:
      - ecommerce-network

  mongo-inventory:
    image: mongo:7
    volumes:
      - mongo-inventory-data:/data/db
    restart: unless-stopped
    networks:
      - ecommerce-network

  mongo-payment:
    image: mongo:7
    volumes:
      - mongo-payment-data:/data/db
    restart: unless-stopped
    networks:
      - ecommerce-network

  #================================================================
  # INFRASTRUCTURE
  #================================================================
  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    ports:
      - '5672:5672'
      - '15672:15672'
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
    restart: unless-stopped
    networks:
      - ecommerce-network

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    restart: unless-stopped
    networks:
      - ecommerce-network

  redis-seckill:
    image: redis:7-alpine
    ports:
      - '6380:6380'
    volumes:
      - redis-seckill-data:/data
    command: redis-server --port 6380 --maxmemory-policy noeviction --appendonly yes
    restart: unless-stopped
    networks:
      - ecommerce-network

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - '16686:16686'
      - '4318:4318'
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    restart: unless-stopped
    networks:
      - ecommerce-network

#================================================================
# NETWORKS & VOLUMES
#================================================================
networks:
  ecommerce-network:
    driver: bridge

volumes:
  mongo-auth-data:
  mongo-product-data:
  mongo-order-data:
  mongo-inventory-data:
  mongo-payment-data:
  rabbitmq-data:
  redis-data:
  redis-seckill-data:
```

Lưu file: `Ctrl+O`, `Enter`, `Ctrl+X`

## 6. Build và Khởi động

### 6.1 Build images (lần đầu mất ~5-10 phút)

```bash
cd ~/em-project
docker-compose -f docker-compose.prod.yml build
```

### 6.2 Khởi động tất cả services

```bash
docker-compose -f docker-compose.prod.yml up -d
```

### 6.3 Kiểm tra trạng thái

```bash
# Xem tất cả containers
docker-compose -f docker-compose.prod.yml ps

# Output mong đợi - tất cả phải "Up":
# NAME                STATUS
# api-gateway         Up
# auth                Up
# order               Up
# product             Up
# inventory           Up
# payment             Up
# seckill             Up
# mongo-auth          Up
# mongo-product       Up
# mongo-order         Up
# mongo-inventory     Up
# mongo-payment       Up
# rabbitmq            Up
# redis               Up
# redis-seckill       Up
# jaeger              Up
```

### 6.4 Xem logs nếu có lỗi

```bash
# Xem logs tất cả
docker-compose -f docker-compose.prod.yml logs

# Xem logs 1 service cụ thể
docker-compose -f docker-compose.prod.yml logs api-gateway
docker-compose -f docker-compose.prod.yml logs order

# Follow logs (real-time)
docker-compose -f docker-compose.prod.yml logs -f
```

## 7. Test hệ thống

### 7.1 Lấy External IP của VM

```bash
# Chạy trong VM
curl ifconfig.me

# Hoặc xem trên GCP Console: Compute Engine → VM Instances → External IP
# Ví dụ: 35.198.xxx.xxx
```

### 7.2 Test các endpoints

```bash
# Thay YOUR_IP bằng External IP
export VM_IP="35.198.xxx.xxx"

# 1. Health check
curl http://$VM_IP:3003/health

# 2. Register user
curl -X POST http://$VM_IP:3003/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@test.com","password":"password123"}'

# 3. Login (lấy token)
curl -X POST http://$VM_IP:3003/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}'

# 4. Lấy products (dùng token từ bước 3)
curl http://$VM_IP:3003/api/products \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### 7.3 Access UI quản lý

| Service     | URL                    | Credentials   |
| ----------- | ---------------------- | ------------- |
| API Gateway | `http://YOUR_IP:3003`  | -             |
| RabbitMQ UI | `http://YOUR_IP:15672` | guest / guest |
| Jaeger UI   | `http://YOUR_IP:16686` | -             |

## 8. Setup Auto-start khi VM reboot

```bash
# Tạo systemd service
sudo nano /etc/systemd/system/ecommerce.service
```

Nội dung:

```ini
[Unit]
Description=E-Commerce Microservices
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/YOUR_USERNAME/em-project
ExecStart=/usr/local/bin/docker-compose -f docker-compose.prod.yml up -d
ExecStop=/usr/local/bin/docker-compose -f docker-compose.prod.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

> **Lưu ý:** Thay `YOUR_USERNAME` bằng username thực tế (chạy `whoami` để xem)

```bash
# Enable service
sudo systemctl daemon-reload
sudo systemctl enable ecommerce
sudo systemctl start ecommerce

# Kiểm tra status
sudo systemctl status ecommerce
```

---

# Option B: Deploy 3 VMs (Distributed)

> **Phù hợp cho:** Production, cần scale, 100+ users đồng thời

## Kiến trúc

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           MULTI-NODE ARCHITECTURE                               │
└─────────────────────────────────────────────────────────────────────────────────┘

                                    INTERNET
                                       │
                                       ▼
   ┌───────────────────────────────────────────────────────────────────────────┐
   │                        VM1: HOT NODE (High Traffic)                        │
   │                        e2-standard-2 (2 vCPU, 8GB) - ~$50/tháng           │
   │  ┌─────────────┐    ┌─────────────────────────────────────────────────┐   │
   │  │ API Gateway │    │ Seckill Service (x4 replicas)                   │   │
   │  │   :3003     │    │   nginx-hot:80 → seckill:3007 (Load Balanced)   │   │
   │  └──────┬──────┘    │   + redis-seckill:6380                          │   │
   │         │           └─────────────────────────────────────────────────┘   │
   └─────────┼─────────────────────────────────────────────────────────────────┘
             │
    ┌────────┴────────┬──────────────────────────────────────┐
    │                 │                                      │
    ▼                 ▼                                      ▼
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│  VM2: COLD NODE (Write-Heavy)       │  │  VM3: INFRAS NODE (Shared Services) │
│  e2-standard-2 - ~$50/tháng         │  │  e2-medium - ~$25/tháng             │
│                                      │  │                                     │
│  nginx-cold (Load Balancer)          │  │  nginx-infras:80 (Gateway)          │
│  ├── :3002 → Order (x4 replicas)    │  │  ├── /auth → Auth:3001              │
│  ├── :3005 → Inventory (x2 replicas)│  │  └── /products → Product:3004       │
│  └── :3006 → Payment (x2 replicas)  │  │                                     │
│                                      │  │  RabbitMQ :5672, :15672             │
│                                      │  │  Redis :6379                        │
│                                      │  │  Jaeger :16686, :4318                │
└─────────────────────────────────────┘  └─────────────────────────────────────┘

Total: ~$125/tháng
```

## 1. Tạo 3 VMs

### VM1: Hot Node

| Setting      | Value                      |
| ------------ | -------------------------- |
| Name         | `ecommerce-hot-node`       |
| Machine type | `e2-standard-2`            |
| Boot disk    | Ubuntu 22.04 LTS, 30GB SSD |
| Network tags | `ecommerce-hot`            |

### VM2: Cold Node

| Setting      | Value                      |
| ------------ | -------------------------- |
| Name         | `ecommerce-cold-node`      |
| Machine type | `e2-standard-2`            |
| Boot disk    | Ubuntu 22.04 LTS, 30GB SSD |
| Network tags | `ecommerce-cold`           |

### VM3: Infras Node

| Setting      | Value                      |
| ------------ | -------------------------- |
| Name         | `ecommerce-infras-node`    |
| Machine type | `e2-medium`                |
| Boot disk    | Ubuntu 22.04 LTS, 30GB SSD |
| Network tags | `ecommerce-infras`         |

## 2. Firewall Rules

### Rule 1: Hot Node (Public)

```
Name: allow-hot-node
Target tags: ecommerce-hot
Source: 0.0.0.0/0
Ports: tcp:3003
```

### Rule 2: Internal communication

```
Name: allow-internal
Target tags: ecommerce-hot, ecommerce-cold, ecommerce-infras
Source: 10.0.0.0/8
Ports: tcp:80,3001-3007,5672,6379,6380,4318,15672,16686
```

## 3. Cài đặt trên mỗi VM

SSH vào **từng VM** và chạy:

```bash
# Update & install Docker
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Clone project
sudo apt install git -y
cd ~
git clone https://github.com/KinasTomes/em-project.git
cd em-project
```

## 4. Lấy Internal IPs

Sau khi tạo xong 3 VMs, ghi lại **Internal IP** của mỗi VM từ GCP Console:

```
VM1 (Hot Node):    10.148.0.X
VM2 (Cold Node):   10.148.0.Y
VM3 (Infras Node): 10.148.0.Z
```

## 5. Tạo .env files

### VM3 (Infras) - `.env.infras-node`

```bash
nano .env.infras-node
```

```dotenv
NODE_ENV=production
HOT_NODE_IP=10.148.0.X
COLD_NODE_IP=10.148.0.Y
INFRAS_NODE_IP=10.148.0.Z

# MongoDB Atlas
MONGODB_AUTH_URI=mongodb+srv://user:pass@cluster.mongodb.net/authDB
MONGODB_PRODUCT_URI=mongodb+srv://user:pass@cluster.mongodb.net/productDB

JWT_SECRET=your-64-char-secret-here
```

### VM2 (Cold) - `.env.cold-node`

```bash
nano .env.cold-node
```

```dotenv
NODE_ENV=production
HOT_NODE_IP=10.148.0.X
COLD_NODE_IP=10.148.0.Y
INFRAS_NODE_IP=10.148.0.Z

MONGODB_ORDER_URI=mongodb+srv://user:pass@cluster.mongodb.net/orderDB
MONGODB_INVENTORY_URI=mongodb+srv://user:pass@cluster.mongodb.net/inventoryDB
MONGODB_PAYMENT_URI=mongodb+srv://user:pass@cluster.mongodb.net/paymentDB

JWT_SECRET=your-64-char-secret-here
```

### VM1 (Hot) - `.env.hot-node`

```bash
nano .env.hot-node
```

```dotenv
NODE_ENV=production
API_GATEWAY_PORT=3003
HOT_NODE_IP=10.148.0.X
COLD_NODE_IP=10.148.0.Y
INFRAS_NODE_IP=10.148.0.Z

JWT_SECRET=your-64-char-secret-here
SECKILL_ADMIN_KEY=your-admin-key-here
```

## 6. Khởi động theo thứ tự

**QUAN TRỌNG: Khởi động theo thứ tự Infras → Cold → Hot**

### Step 1: VM3 (Infras) - TRƯỚC

```bash
cd ~/em-project
docker-compose --env-file .env.infras-node -f docker-compose.infras.yml build
docker-compose --env-file .env.infras-node -f docker-compose.infras.yml up -d

# Chờ RabbitMQ ready (~30s)
sleep 30
docker-compose -f docker-compose.infras.yml ps
```

### Step 2: VM2 (Cold)

```bash
cd ~/em-project
docker-compose --env-file .env.cold-node -f docker-compose.cold-node.yml build
docker-compose --env-file .env.cold-node -f docker-compose.cold-node.yml up -d

docker-compose -f docker-compose.cold-node.yml ps
```

### Step 3: VM1 (Hot) - CUỐI

```bash
cd ~/em-project
docker-compose --env-file .env.hot-node -f docker-compose.hot-node.yml build
docker-compose --env-file .env.hot-node -f docker-compose.hot-node.yml up -d

docker-compose -f docker-compose.hot-node.yml ps
```

## 7. Test

```bash
# Lấy External IP của VM1 (Hot Node)
curl http://HOT_NODE_EXTERNAL_IP:3003/health
```

---

# Setup MongoDB Atlas

> **Recommended:** Dùng MongoDB Atlas thay vì self-hosted để có backup, monitoring tự động

## 1. Tạo tài khoản

1. Vào https://www.mongodb.com/cloud/atlas
2. Sign up (free tier có sẵn)

## 2. Tạo Cluster

1. **Create Cluster** → Chọn **M0 (Free)**
2. Provider: **Google Cloud**
3. Region: **asia-southeast1 (Singapore)**
4. Cluster Name: `ecommerce-cluster`

## 3. Tạo Database User

1. **Database Access** → **Add New Database User**
2. Username: `ecommerce-admin`
3. Password: Generate secure password (copy lại!)
4. Role: **Read and write to any database**

## 4. Whitelist IP

1. **Network Access** → **Add IP Address**
2. Chọn **Allow Access from Anywhere** (0.0.0.0/0)
   > ⚠️ Trong production thực, chỉ whitelist IP của VMs

## 5. Lấy Connection String

1. **Clusters** → **Connect** → **Connect your application**
2. Copy connection string:

```
mongodb+srv://ecommerce-admin:<password>@ecommerce-cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

3. Thay `<password>` bằng password đã tạo
4. Thêm database name vào cuối URL:

```
mongodb+srv://ecommerce-admin:PASSWORD@ecommerce-cluster.xxxxx.mongodb.net/authDB?retryWrites=true&w=majority
```

## 6. Cập nhật .env

```dotenv
MONGODB_AUTH_URI=mongodb+srv://ecommerce-admin:PASSWORD@cluster.mongodb.net/authDB?retryWrites=true&w=majority
MONGODB_PRODUCT_URI=mongodb+srv://ecommerce-admin:PASSWORD@cluster.mongodb.net/productDB?retryWrites=true&w=majority
MONGODB_ORDER_URI=mongodb+srv://ecommerce-admin:PASSWORD@cluster.mongodb.net/orderDB?retryWrites=true&w=majority
MONGODB_INVENTORY_URI=mongodb+srv://ecommerce-admin:PASSWORD@cluster.mongodb.net/inventoryDB?retryWrites=true&w=majority
MONGODB_PAYMENT_URI=mongodb+srv://ecommerce-admin:PASSWORD@cluster.mongodb.net/paymentDB?retryWrites=true&w=majority
```

---

# Quản lý & Monitoring

## Các lệnh thường dùng

```bash
# Xem trạng thái containers
docker-compose -f docker-compose.prod.yml ps

# Xem logs
docker-compose -f docker-compose.prod.yml logs -f
docker-compose -f docker-compose.prod.yml logs -f api-gateway
docker-compose -f docker-compose.prod.yml logs -f order

# Restart 1 service
docker-compose -f docker-compose.prod.yml restart api-gateway

# Restart toàn bộ
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d

# Update code
cd ~/em-project
git pull origin main
docker-compose -f docker-compose.prod.yml build
docker-compose -f docker-compose.prod.yml up -d

# Xem resource usage
docker stats
```

## Monitoring UIs

| Service  | URL               | Mô tả                           |
| -------- | ----------------- | ------------------------------- |
| RabbitMQ | `http://IP:15672` | Queue monitoring, message rates |
| Jaeger   | `http://IP:16686` | Distributed tracing             |

## Backup MongoDB

```bash
# Nếu dùng self-hosted MongoDB
docker exec mongo-order mongodump --out /backup
docker cp mongo-order:/backup ./backup-$(date +%Y%m%d)
```

---

# Troubleshooting

## Service không start được

```bash
# Xem logs chi tiết
docker-compose -f docker-compose.prod.yml logs SERVICE_NAME

# Kiểm tra container exit code
docker ps -a
```

## Không connect được MongoDB

```bash
# Test connection từ trong container
docker exec -it api-gateway sh
# Trong container:
nc -zv mongo-auth 27017
```

## RabbitMQ connection refused

```bash
# Đợi RabbitMQ ready
docker-compose -f docker-compose.prod.yml logs rabbitmq

# Restart services sau khi RabbitMQ ready
docker-compose -f docker-compose.prod.yml restart order inventory payment
```

## Out of disk space

```bash
# Xem disk usage
df -h

# Dọn dẹp Docker
docker system prune -a
docker volume prune
```

## Out of memory

```bash
# Xem memory usage
free -h
docker stats

# Tăng VM size hoặc giảm replicas
```

---

# Security Checklist

- [ ] Đổi JWT_SECRET (64+ characters, random)
- [ ] Đổi SECKILL_ADMIN_KEY
- [ ] Dùng MongoDB Atlas với authentication
- [ ] Firewall: Chỉ mở port 3003 ra public
- [ ] Firewall: Block RabbitMQ/Redis từ internet
- [ ] Setup SSL với Nginx + Let's Encrypt (optional)
- [ ] Không commit .env vào git

---

# Chi phí ước tính

## Option A: 1 VM

| Resource         | Cost/tháng     |
| ---------------- | -------------- |
| e2-standard-2 VM | ~$50           |
| 50GB SSD         | ~$8            |
| Network          | ~$2            |
| MongoDB Atlas M0 | Free           |
| **Total**        | **~$60/tháng** |

## Option B: 3 VMs

| Resource            | Cost/tháng      |
| ------------------- | --------------- |
| VM1 (e2-standard-2) | ~$50            |
| VM2 (e2-standard-2) | ~$50            |
| VM3 (e2-medium)     | ~$25            |
| Disks (90GB)        | ~$15            |
| Network             | ~$5             |
| MongoDB Atlas M0    | Free            |
| **Total**           | **~$145/tháng** |

> **Lưu ý:** GCP cho $300 credit free trong 90 ngày đầu!
