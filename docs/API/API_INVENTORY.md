## Inventory Service

| Method | API Gateway | Service Endpoint | Auth | Description |
|--------|-------------|------------------|------|-------------|
| GET | `/inventory` | `/api/inventory` | ❌ | Lấy danh sách inventory |
| GET | `/inventory/alerts/low-stock` | `/api/inventory/alerts/low-stock` | ❌ | Cảnh báo hàng sắp hết |
| GET | `/inventory/alerts/out-of-stock` | `/api/inventory/alerts/out-of-stock` | ❌ | Danh sách hết hàng |
| POST | `/inventory/check-availability` | `/api/inventory/check-availability` | ❌ | Kiểm tra tồn kho nhiều sản phẩm |
| GET | `/inventory/:productId` | `/api/inventory/:productId` | ❌ | Lấy inventory của sản phẩm |
| POST | `/inventory` | `/api/inventory` | ❌ | Tạo inventory mới |
| POST | `/inventory/:productId/reserve` | `/api/inventory/:productId/reserve` | ❌ | Đặt trước hàng |
| POST | `/inventory/:productId/release` | `/api/inventory/:productId/release` | ❌ | Giải phóng hàng đã đặt |
| POST | `/inventory/:productId/confirm` | `/api/inventory/:productId/confirm` | ❌ | Xác nhận giao hàng |
| POST | `/inventory/:productId/restock` | `/api/inventory/:productId/restock` | ❌ | Nhập thêm hàng |
| PATCH | `/inventory/:productId` | `/api/inventory/:productId` | ❌ | Điều chỉnh inventory |
| DELETE | `/inventory/:productId` | `/api/inventory/:productId` | ❌ | Xóa inventory |

### GET /inventory

Lấy danh sách inventory với pagination.

**Request:**
```http
GET /inventory?page=1&limit=50 HTTP/1.1
```

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| page | number | 1 | Trang hiện tại |
| limit | number | 50 | Số items mỗi trang |

**Response (200 OK):**
```json
{
  "items": [
    {
      "_id": "507f1f77bcf86cd799439030",
      "productId": "507f1f77bcf86cd799439011",
      "available": 100,
      "reserved": 5,
      "sold": 20
    }
  ],
  "total": 50,
  "page": 1,
  "pages": 1
}
```

### GET /inventory/:productId

Lấy inventory của một sản phẩm.

**Request:**
```http
GET /inventory/507f1f77bcf86cd799439011 HTTP/1.1
```

**Response (200 OK):**
```json
{
  "_id": "507f1f77bcf86cd799439030",
  "productId": "507f1f77bcf86cd799439011",
  "available": 100,
  "reserved": 5,
  "sold": 20
}
```

### POST /inventory

Tạo inventory record mới.

**Request:**
```http
POST /inventory HTTP/1.1
Content-Type: application/json

{
  "productId": "507f1f77bcf86cd799439011",
  "available": 100
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| productId | string | ✅ | Product ID |
| available | number | ❌ | Số lượng có sẵn (default: 0) |

**Response (201 Created):**
```json
{
  "_id": "507f1f77bcf86cd799439030",
  "productId": "507f1f77bcf86cd799439011",
  "available": 100,
  "reserved": 0,
  "sold": 0
}
```

### POST /inventory/:productId/reserve

Đặt trước hàng cho đơn hàng.

**Request:**
```http
POST /inventory/507f1f77bcf86cd799439011/reserve HTTP/1.1
Content-Type: application/json

{
  "quantity": 2
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| quantity | number | ✅ | Số lượng cần đặt trước (> 0) |

**Response (200 OK):**
```json
{
  "success": true,
  "available": 98,
  "reserved": 7
}
```

**Response (409 Conflict):**
```json
{
  "success": false,
  "message": "Insufficient stock",
  "available": 1,
  "requested": 2
}
```

### POST /inventory/:productId/release

Giải phóng hàng đã đặt trước (khi hủy đơn).

**Request:**
```http
POST /inventory/507f1f77bcf86cd799439011/release HTTP/1.1
Content-Type: application/json

{
  "quantity": 2
}
```

**Response (200 OK):**
```json
{
  "message": "Released 2 reserved units",
  "inventory": {
    "productId": "507f1f77bcf86cd799439011",
    "available": 100,
    "reserved": 3,
    "sold": 20
  }
}
```

### POST /inventory/:productId/confirm

Xác nhận giao hàng (chuyển từ reserved sang sold).

**Request:**
```http
POST /inventory/507f1f77bcf86cd799439011/confirm HTTP/1.1
Content-Type: application/json

{
  "quantity": 2
}
```

**Response (200 OK):**
```json
{
  "message": "Confirmed fulfillment of 2 units",
  "inventory": {
    "productId": "507f1f77bcf86cd799439011",
    "available": 98,
    "reserved": 3,
    "sold": 22
  }
}
```

### POST /inventory/:productId/restock

Nhập thêm hàng vào kho.

**Request:**
```http
POST /inventory/507f1f77bcf86cd799439011/restock HTTP/1.1
Content-Type: application/json

{
  "quantity": 50
}
```

**Response (200 OK):**
```json
{
  "message": "Restocked 50 units",
  "inventory": {
    "productId": "507f1f77bcf86cd799439011",
    "available": 150,
    "reserved": 5,
    "sold": 20
  }
}
```

### PATCH /inventory/:productId

Điều chỉnh inventory thủ công.

**Request:**
```http
PATCH /inventory/507f1f77bcf86cd799439011 HTTP/1.1
Content-Type: application/json

{
  "availableDelta": -10,
  "reservedDelta": 5
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| availableDelta | number | ✅ | Thay đổi số lượng available (có thể âm) |
| reservedDelta | number | ❌ | Thay đổi số lượng reserved (default: 0) |

**Response (200 OK):**
```json
{
  "message": "Inventory adjusted successfully",
  "inventory": {
    "productId": "507f1f77bcf86cd799439011",
    "available": 90,
    "reserved": 10,
    "sold": 20
  }
}
```

### DELETE /inventory/:productId

Xóa inventory record.

**Request:**
```http
DELETE /inventory/507f1f77bcf86cd799439011 HTTP/1.1
```

**Response (204 No Content):** Không có body

### GET /inventory/alerts/low-stock

Lấy danh sách sản phẩm sắp hết hàng.

**Request:**
```http
GET /inventory/alerts/low-stock?threshold=10 HTTP/1.1
```

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| threshold | number | 10 | Ngưỡng cảnh báo |

**Response (200 OK):**
```json
{
  "threshold": 10,
  "count": 3,
  "items": [
    {
      "productId": "507f1f77bcf86cd799439011",
      "available": 5,
      "reserved": 2
    }
  ]
}
```

### GET /inventory/alerts/out-of-stock

Lấy danh sách sản phẩm hết hàng.

**Request:**
```http
GET /inventory/alerts/out-of-stock HTTP/1.1
```

**Response (200 OK):**
```json
{
  "count": 2,
  "items": [
    {
      "productId": "507f1f77bcf86cd799439012",
      "available": 0,
      "reserved": 0
    }
  ]
}
```

### POST /inventory/check-availability

Kiểm tra tồn kho nhiều sản phẩm cùng lúc.

**Request:**
```http
POST /inventory/check-availability HTTP/1.1
Content-Type: application/json

{
  "productIds": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
}
```

**Response (200 OK):**
```json
{
  "507f1f77bcf86cd799439011": {
    "available": 100,
    "reserved": 5,
    "inStock": true
  },
  "507f1f77bcf86cd799439012": {
    "available": 0,
    "reserved": 0,
    "inStock": false
  }
}
```