# Docker Deployment Guide

## 🚀 Quick Start

### 1. **Build and Start All Services**

```bash
docker-compose up --build
```

### 2. **Access Services**

- **API Gateway**: http://localhost:3003
- **Auth Service**: http://localhost:3001
- **Product Service**: http://localhost:3004
- **Order Service**: http://localhost:3002
- **RabbitMQ Management**: http://localhost:15672 (guest/guest)
- **Jaeger UI**: http://localhost:16686

---

## 📊 Service Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Docker Network: ecommerce-network          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐                                               │
│  │ API Gateway  │  :3003                                        │
│  │ (api-gateway)│                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│    ┌────┼────┬──────────┐                                       │
│    │    │    │          │                                       │
│    ▼    ▼    ▼          ▼                                       │
│  ┌────┐┌────┐┌────┐  ┌────────┐                                │
│  │Auth││Prod││Ordr│  │ Jaeger │ :16686 (UI)                    │
│  │3001││3004││3002│  │        │ :4318 (OTLP)                   │
│  └─┬──┘└─┬──┘└─┬──┘  └────────┘                                │
│    │     │     │                                                │
│    ▼     ▼     ▼          ┌──────────┐                         │
│  ┌───┐ ┌───┐ ┌───┐        │ RabbitMQ │ :5672 (AMQP)            │
│  │MDB│ │MDB│ │MDB│◄───────┤          │ :15672 (Mgmt UI)        │
│  │   │ │   │ │   │        └──────────┘                         │
│  └───┘ └───┘ └───┘                                              │
│  auth  prod  order                                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Configuration

### **Environment Variables**

All environment variables are defined directly in `docker-compose.yml` using the `environment` key.

**Key configurations:**

| Variable | Description | Value in Docker |
|----------|-------------|-----------------|
| `AUTH_SERVICE_URL` | Auth service URL | `http://auth:3001` |
| `PRODUCT_SERVICE_URL` | Product service URL | `http://product:3004` |
| `ORDER_SERVICE_URL` | Order service URL | `http://order:3002` |
| `MONGODB_AUTH_URI` | MongoDB Auth DB | `mongodb://root:example@mongo_auth:27017/auth?authSource=admin` |
| `MONGODB_PRODUCT_URI` | MongoDB Product DB | `mongodb://root:example@mongo_product:27017/product?authSource=admin` |
| `MONGODB_ORDER_URI` | MongoDB Order DB | `mongodb://root:example@mongo_order:27017/order?authSource=admin` |
| `RABBITMQ_URL` | RabbitMQ URL | `amqp://rabbitmq:5672` |
| `JAEGER_ENDPOINT` | Jaeger collector | `http://jaeger:4318/v1/traces` |
| `JWT_SECRET` | JWT signing key | `${JWT_SECRET}` (from .env) |

---

## 📝 Port Mapping

| Service | Internal Port | External Port | Description |
|---------|---------------|---------------|-------------|
| API Gateway | 3003 | 3003 | Main entry point |
| Auth | 3001 | 3001 | Authentication |
| Product | 3004 | 3004 | Product management |
| Order | 3002 | 3002 | Order processing |
| RabbitMQ | 5672 | 5672 | Message broker |
| RabbitMQ Mgmt | 15672 | 15672 | Management UI |
| Jaeger UI | 16686 | 16686 | Tracing UI |
| Jaeger OTLP | 4318 | 4318 | Trace collector |
| MongoDB Auth | 27017 | 27017 | Auth database |
| MongoDB Product | 27017 | 27018 | Product database |
| MongoDB Order | 27017 | 27019 | Order database |

---

## 🛠️ Common Commands

### **Start Services**
```bash
# Foreground (with logs)
docker-compose up

# Background (detached)
docker-compose up -d

# Rebuild images
docker-compose up --build
```

### **Stop Services**
```bash
# Stop all services
docker-compose down

# Stop and remove volumes (DANGER: deletes data)
docker-compose down -v
```

### **View Logs**
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f auth
docker-compose logs -f product
docker-compose logs -f api-gateway
```

### **Restart a Service**
```bash
docker-compose restart auth
docker-compose restart product
```

### **Check Status**
```bash
docker-compose ps
```

---

## 🔍 Debugging

### **1. Check Service Health**
```bash
# Check all containers
docker ps

# Check logs for errors
docker-compose logs api-gateway
docker-compose logs auth
```

### **2. Access Container Shell**
```bash
# Auth service
docker exec -it <auth_container_id> sh

# MongoDB
docker exec -it mongo_auth mongosh -u root -p example
```

### **3. Network Issues**
```bash
# Check network
docker network inspect em-project_ecommerce-network

# Test connectivity between containers
docker exec -it api-gateway ping auth
docker exec -it auth ping mongo_auth
```

### **4. View Traces in Jaeger**
1. Open http://localhost:16686
2. Select service from dropdown (e.g., "api-gateway", "auth-service")
3. Click "Find Traces"

---

## 🗄️ Database Access

### **MongoDB (Auth)**
```bash
# Connect to auth database
docker exec -it mongo_auth mongosh -u root -p example

# Use auth database
use auth

# Show collections
show collections

# Query users
db.users.find()
```

### **MongoDB (Product)**
```bash
docker exec -it mongo_product mongosh -u root -p example
use product
db.products.find()
```

### **MongoDB (Order)**
```bash
docker exec -it mongo_order mongosh -u root -p example
use order
db.orders.find()
```

---

## 📦 Volumes

Persistent data is stored in Docker volumes:

```bash
# List volumes
docker volume ls | grep em-project

# Inspect volume
docker volume inspect em-project_mongo_auth_data

# Remove all volumes (DANGER: deletes data)
docker-compose down -v
```

---

## 🔄 Development vs Production

### **Development (Local)**
- Use `pnpm dev:all` (runs on host machine)
- MongoDB Atlas for databases
- Service URLs: `http://localhost:PORT`
- Pretty-printed logs with colors

### **Production (Docker)**
- Use `docker-compose up`
- Local MongoDB containers
- Service URLs: `http://service-name:PORT`
- Structured JSON logs
- All services in isolated network

---

## ⚠️ Important Notes

1. **JWT_SECRET**: Change `JWT_SECRET` in `.env` for production deployments
2. **MongoDB Passwords**: Change MongoDB credentials in production
3. **Data Persistence**: Volumes ensure data persists across container restarts
4. **Network Isolation**: All services run in `ecommerce-network` (isolated from host)
5. **Health Checks**: RabbitMQ has built-in health check, add for other services if needed

---

## 🚨 Troubleshooting

### **Service won't start**
```bash
# Check logs
docker-compose logs service-name

# Rebuild image
docker-compose build --no-cache service-name
docker-compose up service-name
```

### **Database connection errors**
- Verify MongoDB containers are running: `docker ps`
- Check MongoDB credentials in docker-compose.yml
- Verify connection string format

### **Port already in use**
```bash
# Find process using port
netstat -ano | findstr :3001  # Windows
lsof -i :3001                 # Mac/Linux

# Kill process or change port in docker-compose.yml
```

---

## 📚 Additional Resources

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [RabbitMQ Management Plugin](https://www.rabbitmq.com/management.html)
- [MongoDB Docker Hub](https://hub.docker.com/_/mongo)
