## Auth Service

| Method | API Gateway | Service Endpoint | Auth | Description |
|--------|-------------|------------------|------|-------------|
| POST | `/auth/login` | `/login` | ❌ | Đăng nhập, trả về JWT token |
| POST | `/auth/register` | `/register` | ❌ | Đăng ký tài khoản mới |
| GET | `/auth/dashboard` | `/dashboard` | ✅ | Trang dashboard (test auth) |

### POST /auth/login

Đăng nhập và lấy JWT token.

**Request:**
```http
POST /auth/login HTTP/1.1
Content-Type: application/json

{
  "username": "user123",
  "password": "password123"
}
```

**Response (200 OK):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (400 Bad Request):**
```json
{
  "message": "Invalid credentials"
}
```

### POST /auth/register

Đăng ký tài khoản mới.

**Request:**
```http
POST /auth/register HTTP/1.1
Content-Type: application/json

{
  "username": "newuser",
  "password": "securepassword123"
}
```

**Response (200 OK):**
```json
{
  "message": "User registered successfully",
  "userId": "507f1f77bcf86cd799439011"
}
```

**Response (400 Bad Request):**
```json
{
  "message": "Username already taken"
}
```

### GET /auth/dashboard

Test endpoint để kiểm tra authentication.

**Request:**
```http
GET /auth/dashboard HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Response (200 OK):**
```json
{
  "message": "Welcome to dashboard"
}
```