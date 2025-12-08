## Product Service

| Method | API Gateway | Service Endpoint | Auth | Description |
|--------|-------------|------------------|------|-------------|
| GET | `/products` | `/api/products` | ❌ | Lấy danh sách sản phẩm |
| GET | `/products/:id` | `/api/products/:id` | ❌ | Lấy chi tiết sản phẩm |
| POST | `/products` | `/api/products` | ✅ | Tạo sản phẩm mới |
| PUT | `/products/:id` | `/api/products/:id` | ✅ | Cập nhật sản phẩm |
| DELETE | `/products/:id` | `/api/products/:id` | ✅ | Xóa sản phẩm |

### GET /products

Lấy danh sách tất cả sản phẩm.

**Request:**
```http
GET /products HTTP/1.1
Authorization: Bearer <token>
```

**Response (200 OK):**
```json
[
  {
    "_id": "507f1f77bcf86cd799439011",
    "name": "iPhone 15 Pro",
    "price": 29990000,
    "description": "Apple iPhone 15 Pro 256GB"
  },
  {
    "_id": "507f1f77bcf86cd799439012",
    "name": "Samsung Galaxy S24",
    "price": 22990000,
    "description": "Samsung Galaxy S24 Ultra 512GB"
  }
]
```

### GET /products/:id

Lấy chi tiết một sản phẩm.

**Request:**
```http
GET /products/507f1f77bcf86cd799439011 HTTP/1.1
Authorization: Bearer <token>
```

**Response (200 OK):**
```json
{
  "_id": "507f1f77bcf86cd799439011",
  "name": "iPhone 15 Pro",
  "price": 29990000,
  "description": "Apple iPhone 15 Pro 256GB"
}
```

**Response (404 Not Found):**
```json
{
  "message": "Product not found"
}
```

### POST /products

Tạo sản phẩm mới (tự động tạo inventory record).

**Request:**
```http
POST /products HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "MacBook Pro M3",
  "price": 49990000,
  "description": "Apple MacBook Pro 14 inch M3 Pro",
  "available": 100
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | ✅ | Tên sản phẩm |
| price | number | ✅ | Giá sản phẩm (VND) |
| description | string | ❌ | Mô tả sản phẩm |
| available | number | ❌ | Số lượng tồn kho ban đầu (default: 0) |

**Response (201 Created):**
```json
{
  "_id": "507f1f77bcf86cd799439013",
  "name": "MacBook Pro M3",
  "price": 49990000,
  "description": "Apple MacBook Pro 14 inch M3 Pro"
}
```

### PUT /products/:id

Cập nhật thông tin sản phẩm.

**Request:**
```http
PUT /products/507f1f77bcf86cd799439011 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "iPhone 15 Pro Max",
  "price": 34990000,
  "description": "Apple iPhone 15 Pro Max 512GB"
}
```

**Response (200 OK):**
```json
{
  "_id": "507f1f77bcf86cd799439011",
  "name": "iPhone 15 Pro Max",
  "price": 34990000,
  "description": "Apple iPhone 15 Pro Max 512GB"
}
```

### DELETE /products/:id

Xóa sản phẩm (tự động xóa inventory record).

**Request:**
```http
DELETE /products/507f1f77bcf86cd799439011 HTTP/1.1
Authorization: Bearer <token>
```

**Response (204 No Content):** Không có body
