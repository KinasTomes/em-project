# API Endpoints Documentation

Tài liệu này liệt kê tất cả các endpoint có thể gọi qua API Gateway và mapping tương ứng đến từng service.

## Overview

| Service | API Gateway Prefix | Internal Service | Port |
|---------|-------------------|------------------|------|
| Auth | `/auth` | auth-service | 3001 |
| Product | `/products` | product-service | 3004 |
| Order | `/orders` | order-service | 3002 |
| Inventory | `/inventory` | inventory-service | 3005 |
| Payment | `/payments` | payment-service | 3006 |
| Seckill | `/seckill` | seckill-service | 3007 |
| Seckill Admin | `/admin/seckill` | seckill-service | 3007 |

---

## Authentication

- **✅ Auth Required:** Cần JWT token trong header `Authorization: Bearer <token>`
- **❌ Public:** Không cần authentication
- **🔑 Admin:** Cần header `X-Admin-Key`

API Gateway sẽ verify JWT và set các headers cho downstream services:
- `X-User-ID`: User ID từ token
- `X-User-Email`: Email (optional)
- `X-User-Role`: Role (optional)

---

## Payment Service

| Method | API Gateway | Service Endpoint | Auth | Description |
|--------|-------------|------------------|------|-------------|
| GET | `/payments/health/live` | `/api/payments/health/live` | ❌ | Liveness check |
| GET | `/payments/health/ready` | `/api/payments/health/ready` | ❌ | Readiness check |

> **Note:** Payment service chủ yếu xử lý qua message queue (RabbitMQ), không expose nhiều HTTP endpoints.

### GET /payments/health/live

Kiểm tra service còn sống.

**Request:**
```http
GET /payments/health/live HTTP/1.1
```

**Response (200 OK):**
```json
{
  "status": "ok",
  "service": "payment",
  "live": true
}
```

### GET /payments/health/ready

Kiểm tra service sẵn sàng nhận request.

**Request:**
```http
GET /payments/health/ready HTTP/1.1
```

**Response (200 OK):**
```json
{
  "status": "ok",
  "service": "payment",
  "ready": true
}
```
---

## Error Response Format

Tất cả các endpoint đều trả về error theo format thống nhất:

```json
{
  "error": "ERROR_CODE",
  "message": "Human readable error message",
  "details": []
}
```

### Common HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | OK - Request thành công |
| 201 | Created - Tạo resource thành công |
| 202 | Accepted - Request được chấp nhận, đang xử lý async |
| 204 | No Content - Xóa thành công |
| 400 | Bad Request - Request không hợp lệ |
| 401 | Unauthorized - Chưa đăng nhập hoặc token hết hạn |
| 403 | Forbidden - Không có quyền truy cập |
| 404 | Not Found - Resource không tồn tại |
| 409 | Conflict - Xung đột (duplicate, out of stock, etc.) |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error - Lỗi server |
| 502 | Bad Gateway - Downstream service error |
| 503 | Service Unavailable - Service không khả dụng |

---

## Rate Limiting

API Gateway áp dụng rate limiting:

- **General:** 100 requests/phút cho tất cả endpoints
- **Auth endpoints:** 10 requests/phút cho `/auth/login` và `/auth/register`

Khi vượt quá limit, response sẽ là:
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Please try again later.",
  "retryAfter": 60
}
```
