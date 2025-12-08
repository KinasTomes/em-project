# Flash Sale Simple Test (k6)

Test load cho Seckill service với k6.

## Flow

```
┌─────────────────┐     ┌─────────────────┐
│   1. setup.js   │ ──► │  2. load.test   │
│  (Node.js)      │     │     (k6)        │
└─────────────────┘     └─────────────────┘
   Tạo products          100 users đồng
   Init campaigns        thời mua hàng
```

## Quick Start

### 1. Config

Mở `setup.js` và điền JWT_SECRET:
```javascript
JWT_SECRET: process.env.JWT_SECRET || 'your-jwt-secret',  // <-- ĐIỀN VÀO
```

### 2. Chạy Setup

```bash
cd tests/flash-sale-simple
node setup.js
```

Output:
```
✅ SETUP COMPLETE
Product IDs (copy to k6 test):
const PRODUCT_IDS = ["6752abc123","6752abc456","6752abc789"];

Or run k6 with:
k6 run -e PRODUCT_IDS='["6752abc123","6752abc456","6752abc789"]' load.test.js
```

### 3. Chạy k6 Test

```bash
# Copy PRODUCT_IDS từ output setup.js
k6 run -e PRODUCT_IDS='["6752abc123","6752abc456","6752abc789"]' load.test.js
```

## Config Options

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `API_BASE` | `http://localhost:3000` | API Gateway URL |
| `ADMIN_KEY` | `admin-secret-key` | Admin key cho seckill init |
| `JWT_SECRET` | `your-jwt-secret` | JWT secret để tạo token |
| `NUM_PRODUCTS` | `3` | Số products tạo |
| `STOCK_PER_PRODUCT` | `50` | Stock mỗi campaign |
| `NUM_USERS` | `100` | Số users đồng thời |
| `PRODUCT_IDS` | `[]` | Product IDs (k6 only) |

## Examples

### Test nhỏ (10 users, 2 products)
```bash
# Setup
NUM_PRODUCTS=2 STOCK_PER_PRODUCT=20 node setup.js

# Test
k6 run -e NUM_USERS=10 -e PRODUCT_IDS='[...]' load.test.js
```

### Test lớn (500 users, 5 products)
```bash
# Setup
NUM_PRODUCTS=5 STOCK_PER_PRODUCT=100 node setup.js

# Test
k6 run -e NUM_USERS=500 -e PRODUCT_IDS='[...]' load.test.js
```

## Metrics

| Metric | Description |
|--------|-------------|
| `buy_success` | Số lượt mua thành công |
| `buy_out_of_stock` | Số lượt hết hàng |
| `buy_already_purchased` | Số lượt đã mua rồi |
| `buy_rate_limited` | Số lượt bị rate limit |
| `buy_errors` | Số lỗi khác |
| `buy_latency` | Latency (p50, p95, p99) |
| `success_rate` | Tỷ lệ thành công |

## Expected Results

Với config mặc định (3 products × 50 stock = 150 slots, 100 users):
- `buy_success` ≈ 100 (tất cả users đều mua được)
- `buy_out_of_stock` = 0
- Stock remaining ≈ 50 (150 - 100)

Với 200 users, 150 slots:
- `buy_success` = 150
- `buy_out_of_stock` = 50
- Stock remaining = 0

## Note về Authentication

Test này dùng `X-User-ID` header thay vì JWT token để đơn giản hóa.
Seckill service đọc user ID từ header này (được API Gateway set sau khi verify JWT).

Nếu API Gateway yêu cầu JWT, bạn cần:
1. Điền đúng `JWT_SECRET`
2. Hoặc tắt auth check cho `/seckill/buy` trong API Gateway
