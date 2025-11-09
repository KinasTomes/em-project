# Inventory Service

Service quản lý tồn kho sản phẩm trong hệ thống E-Commerce Microservices.

## 📋 Mục đích

- Quản lý số lượng tồn kho (available, reserved, backorder)
- Đặt trước stock khi tạo order
- Đồng bộ inventory với Product/Order services qua RabbitMQ
- Cung cấp API cho admin quản lý nhập/xuất kho

## 🚀 Chạy service

### Với Docker Compose (khuyến nghị)

```bash
# Từ thư mục root của project
docker compose up --build inventory
```

### Chạy local (development)

```bash
cd services/inventory
npm install
npm run dev
```

## 📡 API Endpoints

Tất cả endpoints yêu cầu JWT authentication (Bearer token).

### Inventory Management

| Method | Endpoint                    | Mô tả                                |
| ------ | --------------------------- | ------------------------------------ |
| GET    | `/api/inventory`            | Lấy tất cả inventory (có phân trang) |
| GET    | `/api/inventory/:productId` | Lấy inventory của 1 sản phẩm         |
| POST   | `/api/inventory`            | Tạo inventory mới cho sản phẩm       |
| DELETE | `/api/inventory/:productId` | Xóa inventory record                 |

### Stock Operations

| Method | Endpoint                            | Mô tả                        |
| ------ | ----------------------------------- | ---------------------------- |
| POST   | `/api/inventory/:productId/reserve` | Đặt trước stock cho order    |
| POST   | `/api/inventory/:productId/release` | Hủy đặt trước (cancel order) |
| POST   | `/api/inventory/:productId/confirm` | Xác nhận đã xuất hàng        |
| POST   | `/api/inventory/:productId/restock` | Nhập thêm hàng vào kho       |
| PATCH  | `/api/inventory/:productId`         | Điều chỉnh số lượng thủ công |

### Alerts & Monitoring

| Method | Endpoint                             | Mô tả                           |
| ------ | ------------------------------------ | ------------------------------- |
| GET    | `/api/inventory/alerts/low-stock`    | Danh sách sản phẩm sắp hết      |
| GET    | `/api/inventory/alerts/out-of-stock` | Danh sách sản phẩm hết hàng     |
| POST   | `/api/inventory/check-availability`  | Kiểm tra tồn kho nhiều sản phẩm |

## 📨 RabbitMQ Integration

### Consume (Inventory service lắng nghe)

- `product-created`: Tạo inventory khi có sản phẩm mới
- `product-deleted`: Xóa inventory khi xóa sản phẩm
- `inventory-reserve`: Yêu cầu đặt trước stock
- `inventory-release`: Yêu cầu hủy đặt trước
- `inventory-restock`: Nhập hàng vào kho

### Publish (Inventory service gửi đi)

- `inventory-reserved`: Thông báo đã đặt trước thành công
- `inventory-reserve-failed`: Thông báo đặt trước thất bại (hết hàng)

## 🗄️ Database Schema

```javascript
{
  productId: ObjectId,      // Unique, indexed
  available: Number,        // Số lượng có sẵn
  reserved: Number,         // Số lượng đang đặt trước
  backorder: Number,        // Số lượng chờ về hàng
  lastRestockedAt: Date,    // Lần nhập hàng gần nhất
  createdAt: Date,
  updatedAt: Date
}
```

## 🔧 Scripts

```bash
# Seed dữ liệu mẫu
npm run seed

# Đồng bộ inventory với products hiện có
npm run migrate:products
```

## 🌐 Environment Variables

```env
NODE_ENV=development
PORT=3005
MONGODB_INVENTORY_URI=mongodb://root:example@mongo_inventory:27017/inventoryDB?authSource=admin
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
JWT_SECRET=your-secret-key
JAEGER_ENDPOINT=http://jaeger:4318/v1/traces
```

## 📊 Stock Flow

### Khi tạo order:

1. Order service gửi message `inventory-reserve` qua RabbitMQ
2. Inventory service nhận message và kiểm tra stock
3. Nếu đủ: `available -= quantity`, `reserved += quantity`
4. Gửi `inventory-reserved` hoặc `inventory-reserve-failed`

### Khi hủy order:

1. Order service gửi `inventory-release`
2. Inventory service: `available += quantity`, `reserved -= quantity`

### Khi ship hàng:

1. Order service gửi `inventory-confirm`
2. Inventory service: `reserved -= quantity`

## 🧪 Testing

```bash
# Run tests
npm test

# Test với k6 (sau khi services chạy)
k6 run tests/k6/inventory-api.test.js
```

## 📈 Monitoring

- **Health check**: `GET /health`
- **Jaeger tracing**: http://localhost:16686
- **Low stock alerts**: Tự động phát hiện khi `available <= threshold`

## 🔗 Service Dependencies

- MongoDB (port 27020)
- RabbitMQ (port 5672)
- Jaeger (port 4318)
- Auth Service (JWT verification)
- Product Service (sync product IDs)
