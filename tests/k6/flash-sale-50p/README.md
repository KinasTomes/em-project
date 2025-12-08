# Flash Sale Load Test - 50 Products

## Kịch bản test

- **50 sản phẩm**, mỗi sản phẩm có **stock = 50**
- **5000 users** đồng thời mua hàng
- Mỗi product có **100 users** cạnh tranh
- Tỉ lệ mua được kỳ vọng: **50%** (50 stock / 100 users)

## Cách chạy

### 1. Setup - Tạo products và campaigns

```bash
node tests/k6/flash-sale-50p/setup.js
```

Output sẽ tạo file `product-ids.json` chứa danh sách product IDs.

### 2. Chạy k6 load test

```bash
# Cách 1: Tự động đọc từ product-ids.json
k6 run tests/k6/flash-sale-50p/load.test.js

# Cách 2: Truyền product IDs qua env
k6 run -e PRODUCT_IDS='["id1","id2",...]' tests/k6/flash-sale-50p/load.test.js

# Cách 3: Custom config
k6 run \
  -e NUM_USERS=5000 \
  -e USERS_PER_PRODUCT=100 \
  tests/k6/flash-sale-50p/load.test.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE` | `http://35.213.165.98:3003` | API Gateway URL |
| `JWT_SECRET` | (preset) | JWT secret for auth |
| `NUM_USERS` | `5000` | Total concurrent users |
| `NUM_PRODUCTS` | `50` | Number of products |
| `STOCK_PER_PRODUCT` | `50` | Stock per product |
| `USERS_PER_PRODUCT` | `100` | Users competing per product |
| `PRODUCT_IDS` | (from file) | JSON array of product IDs |

## Expected Results

| Metric | Expected Value |
|--------|----------------|
| Total Success | ~2500 (50%) |
| Total OUT_OF_STOCK | ~2500 (50%) |
| Overselling | 0 (NO overselling) |
| p95 Latency | < 2000ms |
| p99 Latency | < 5000ms |

## User Distribution

Users được phân bổ đều vào các products:

```
VU 1-100    → Product 1  (100 users compete for 50 stock)
VU 101-200  → Product 2  (100 users compete for 50 stock)
VU 201-300  → Product 3  (100 users compete for 50 stock)
...
VU 4901-5000 → Product 50 (100 users compete for 50 stock)
```

## Metrics

### Buy Metrics
- `buy_success` - Số lượng mua thành công
- `buy_out_of_stock` - Số lượng hết hàng
- `buy_already_purchased` - Số lượng đã mua rồi
- `buy_rate_limited` - Số lượng bị rate limit
- `buy_errors` - Số lượng lỗi khác
- `buy_latency` - Latency của request mua
- `success_rate` - Tỉ lệ thành công

### Thresholds
- `buy_latency p95 < 2000ms`
- `buy_latency p99 < 5000ms`
- `buy_errors < 100`
- `success_rate` trong khoảng 45-55%

## Validation

Test được coi là **PASSED** khi:
1. Không có overselling (stock không âm)
2. Success rate ~50% (±5%)
3. Latency trong ngưỡng cho phép
4. Không có server errors (5xx)
