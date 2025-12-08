## Seckill Service (Flash Sale)

| Method | API Gateway | Service Endpoint | Auth | Description |
|--------|-------------|------------------|------|-------------|
| POST | `/seckill/buy` | `/seckill/buy` | ✅ | Mua hàng flash sale |
| GET | `/seckill/status/:productId` | `/seckill/status/:productId` | ❌ | Kiểm tra trạng thái campaign |

### POST /seckill/buy

Mua hàng trong flash sale campaign.

**Request:**
```http
POST /seckill/buy HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "productId": "507f1f77bcf86cd799439011"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| productId | string | ✅ | Product ID trong campaign |

**Response (202 Accepted):**
```json
{
  "success": true,
  "orderId": "seckill_507f1f77bcf86cd799439050",
  "message": "Purchase accepted. Order is being processed."
}
```

**Response (400 Bad Request - Campaign chưa bắt đầu):**
```json
{
  "error": "CAMPAIGN_NOT_STARTED",
  "message": "Campaign has not started or does not exist"
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "UNAUTHORIZED",
  "message": "User authentication required"
}
```

**Response (409 Conflict - Hết hàng):**
```json
{
  "error": "OUT_OF_STOCK",
  "message": "Product is out of stock"
}
```

**Response (409 Conflict - Đã mua rồi):**
```json
{
  "error": "ALREADY_PURCHASED",
  "message": "You have already purchased this product"
}
```

**Response (429 Too Many Requests):**
```json
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests. Please try again later."
}
```

### GET /seckill/status/:productId

Kiểm tra trạng thái campaign flash sale.

**Request:**
```http
GET /seckill/status/507f1f77bcf86cd799439011 HTTP/1.1
```

**Response (200 OK):**
```json
{
  "productId": "507f1f77bcf86cd799439011",
  "stock": 100,
  "remaining": 45,
  "price": 9990000,
  "startTime": "2025-12-07T10:00:00.000Z",
  "endTime": "2025-12-07T12:00:00.000Z",
  "status": "active"
}
```

**Response (404 Not Found):**
```json
{
  "error": "CAMPAIGN_NOT_FOUND",
  "message": "Campaign does not exist"
}
```

---

## Seckill Admin Routes

| Method | API Gateway | Service Endpoint | Auth | Description |
|--------|-------------|------------------|------|-------------|
| POST | `/admin/seckill/init` | `/admin/seckill/init` | 🔑 | Khởi tạo campaign flash sale |
| POST | `/admin/seckill/release` | `/admin/seckill/release` | 🔑 | Giải phóng slot thủ công |

> **🔑 Admin Auth:** Yêu cầu header `X-Admin-Key` thay vì JWT token.

### POST /admin/seckill/init

Khởi tạo campaign flash sale mới.

**Request:**
```http
POST /admin/seckill/init HTTP/1.1
X-Admin-Key: your-admin-secret-key
Content-Type: application/json

{
  "productId": "507f1f77bcf86cd799439011",
  "stock": 100,
  "price": 9990000,
  "startTime": "2025-12-07T10:00:00.000Z",
  "endTime": "2025-12-07T12:00:00.000Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| productId | string | ✅ | Product ID |
| stock | number | ✅ | Số lượng hàng flash sale (integer > 0) |
| price | number | ✅ | Giá flash sale (> 0) |
| startTime | string | ✅ | Thời gian bắt đầu (ISO 8601) |
| endTime | string | ✅ | Thời gian kết thúc (ISO 8601, phải sau startTime) |

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Campaign initialized successfully",
  "campaign": {
    "productId": "507f1f77bcf86cd799439011",
    "stock": 100,
    "price": 9990000,
    "startTime": "2025-12-07T10:00:00.000Z",
    "endTime": "2025-12-07T12:00:00.000Z"
  }
}
```

**Response (400 Bad Request):**
```json
{
  "error": "VALIDATION_ERROR",
  "message": "Invalid campaign parameters",
  "details": [
    {
      "path": ["endTime"],
      "message": "endTime must be after startTime"
    }
  ]
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "UNAUTHORIZED",
  "message": "Invalid or missing admin key"
}
```

### POST /admin/seckill/release

Giải phóng slot của user (compensation khi order fail).

**Request:**
```http
POST /admin/seckill/release HTTP/1.1
X-Admin-Key: your-admin-secret-key
Content-Type: application/json

{
  "orderId": "seckill_507f1f77bcf86cd799439050",
  "userId": "user123",
  "productId": "507f1f77bcf86cd799439011",
  "reason": "Payment failed"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| orderId | string | ✅ | Order ID cần release |
| userId | string | ✅ | User ID |
| productId | string | ✅ | Product ID |
| reason | string | ❌ | Lý do release |

**Response (200 OK - Released):**
```json
{
  "success": true,
  "released": true,
  "message": "Slot released successfully"
}
```

**Response (200 OK - Not found):**
```json
{
  "success": true,
  "released": false,
  "message": "User not found in winners set (already released or never purchased)"
}
```

---

## System Endpoints

| Method | API Gateway | Description |
|--------|-------------|-------------|
| GET | `/health` | Health check của API Gateway |
| GET | `/metrics` | Prometheus metrics |

### GET /health

Kiểm tra trạng thái API Gateway.

**Request:**
```http
GET /health HTTP/1.1
```

**Response (200 OK):**
```json
{
  "status": "healthy",
  "service": "api-gateway",
  "timestamp": "2025-12-07T10:30:00.000Z",
  "uptime": 3600.5
}
```

### GET /metrics

Lấy Prometheus metrics.

**Request:**
```http
GET /metrics HTTP/1.1
```

**Response (200 OK):**
```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/products",status="200"} 1234
http_requests_total{method="POST",path="/orders",status="201"} 567
...
```
s