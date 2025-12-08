## Order Service

| Method | API Gateway | Service Endpoint | Auth | Description |
|--------|-------------|------------------|------|-------------|
| GET | `/orders` | `/api/orders` | ✅ | Lấy danh sách đơn hàng của user |
| POST | `/orders` | `/api/orders` | ✅ | Tạo đơn hàng mới |
| GET | `/orders/:id` | `/api/orders/:id` | ✅ | Lấy chi tiết đơn hàng |

### GET /orders

Lấy danh sách đơn hàng của user hiện tại (có pagination).

**Request:**
```http
GET /orders?page=1&limit=20 HTTP/1.1
Authorization: Bearer <token>
```

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| page | number | 1 | Trang hiện tại |
| limit | number | 20 | Số đơn hàng mỗi trang |

**Response (200 OK):**
```json
{
  "orders": [
    {
      "orderId": "507f1f77bcf86cd799439020",
      "products": [
        {
          "productId": "507f1f77bcf86cd799439011",
          "name": "iPhone 15 Pro",
          "price": 29990000,
          "quantity": 1
        }
      ],
      "totalPrice": 29990000,
      "status": "confirmed",
      "cancellationReason": null,
      "createdAt": "2025-12-07T10:30:00.000Z"
    }
  ],
  "pagination": {
    "total": 15,
    "page": 1,
    "pages": 1,
    "limit": 20
  }
}
```

### POST /orders

Tạo đơn hàng mới.

**Request:**
```http
POST /orders HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "ids": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"],
  "quantities": [1, 2]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| ids | string[] | ✅ | Mảng product IDs |
| quantities | number[] | ❌ | Mảng số lượng tương ứng (default: [1, 1, ...]) |

**Response (201 Created):**
```json
{
  "orderId": "507f1f77bcf86cd799439020",
  "products": [
    {
      "productId": "507f1f77bcf86cd799439011",
      "name": "iPhone 15 Pro",
      "price": 29990000,
      "quantity": 1
    },
    {
      "productId": "507f1f77bcf86cd799439012",
      "name": "Samsung Galaxy S24",
      "price": 22990000,
      "quantity": 2
    }
  ],
  "totalPrice": 75970000,
  "status": "pending"
}
```

**Response (400 Bad Request):**
```json
{
  "message": "Product IDs are required"
}
```

**Response (404 Not Found):**
```json
{
  "message": "Product 507f1f77bcf86cd799439099 not found"
}
```

### GET /orders/:id

Lấy chi tiết đơn hàng.

**Request:**
```http
GET /orders/507f1f77bcf86cd799439020 HTTP/1.1
Authorization: Bearer <token>
```

**Response (200 OK):**
```json
{
  "orderId": "507f1f77bcf86cd799439020",
  "products": [
    {
      "productId": "507f1f77bcf86cd799439011",
      "name": "iPhone 15 Pro",
      "price": 29990000,
      "quantity": 1
    }
  ],
  "totalPrice": 29990000,
  "user": "user123",
  "status": "confirmed",
  "cancellationReason": null,
  "createdAt": "2025-12-07T10:30:00.000Z"
}
```

**Order Status Values:**
| Status | Description |
|--------|-------------|
| `pending` | Đơn hàng mới tạo, đang chờ xử lý |
| `confirmed` | Đơn hàng đã xác nhận |
| `paid` | Đã thanh toán |
| `shipped` | Đang giao hàng |
| `delivered` | Đã giao hàng |
| `cancelled` | Đã hủy |
