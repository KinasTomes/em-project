# Seckill Service Documentation

## 1. Tổng Quan (Overview)
Seckill Service (Flash Sale Service) là một microservice hiệu năng cao được thiết kế để xử lý các chiến dịch bán hàng chớp nhoáng (flash sales) với lưu lượng truy cập cực lớn (high concurrency). 

Mục tiêu chính của dịch vụ là đảm bảo tính toàn vẹn của dữ liệu kho hàng (không bán quá số lượng - overselling), ngăn chặn gian lận (mua trùng lặp), và xử lý hàng nghìn yêu cầu mỗi giây mà không làm sập hệ thống.

## 2. Kiến Trúc (Architecture)

### Công Nghệ (Tech Stack)
- **Runtime**: Node.js (Express framework).
- **Database (Hot Data)**: Redis. Đây là thành phần quan trọng nhất, lưu trữ toàn bộ thông tin chiến dịch và kho hàng để đảm bảo tốc độ truy xuất cực nhanh.
- **Message Broker**: RabbitMQ (hoặc tương đương), dùng để xử lý đơn hàng bất đồng bộ (asynchronous processing).
- **Logging**: @ecommerce/logger.
- **Metrics**: Prometheus/Grafana (custom metrics).

### Mô Hình Thiết Kế (Design Patterns)
- **Atomic Operations**: Sử dụng **Lua Scripts** trên Redis để thực hiện các thao tác kiểm tra và trừ kho hàng một cách nguyên tử (atomic), tránh race condition.
- **Event-Driven**: Sau khi giữ chỗ (reserve) thành công, dịch vụ bắn sự kiện `seckill.order.won` để Order Service xử lý tiếp (tạo đơn, thanh toán).
- **Failover & Reliability**: Cơ chế "Ghost Order" fallback - ghi log ra file nểu Message Broker bị lỗi.

## 3. Chức Năng Chính (Core Features)

### 3.1. Khởi Tạo Chiến Dịch (Campaign Initialization)
- **Admin** thiết lập thông tin sản phẩm, số lượng tồn kho (stock), giá, và thời gian bắt đầu/kết thúc.
- Dữ liệu được nạp trực tiếp vào Redis (Pre-warming cache) để sẵn sàng phục vụ.
- **Redis Keys**:
  - `seckill:{productId}:stock`: Số lượng tồn kho còn lại.
  - `seckill:{productId}:total`: Tổng số lượng ban đầu.
  - `seckill:{productId}:price`: Giá bán.
  - `seckill:{productId}:start` / `end`: Thời gian hiệu lực.
  - `seckill:{productId}:users`: Set chứa ID các user đã mua thành công (để chặn mua trùng).

### 3.2. Mua Hàng (Purchase / Buy)
Đây là chức năng quan trọng nhất, xử lý qua `POST /seckill/buy`.
Quy trình xử lý (được gói trong Lua Script `seckill-reserve.lua`):
1.  **Rate Limiting**: Kiểm tra giới hạn request của user trong một khoảng thời gian (Fixed Window).
2.  **Duplicate Check**: Kiểm tra xem user đã mua sản phẩm này chưa (dựa trên Redis Set).
3.  **Campaign Check**: Kiểm tra chiến dịch có tồn tại và còn hiệu lực không.
4.  **Stock Check**: Kiểm tra tồn kho còn > 0 không.
5.  **Reservation**: Nếu tất cả hợp lệ, giảm tồn kho (`DECR`) và thêm user vào danh sách đã mua (`SADD`).

Sau khi Lua script trả về thành công:
- Service tạo `orderId`.
- Bắn sự kiện `seckill.order.won` lên Message Broker.
- Trả về kết quả `202 Accepted` cho client ngay lập tức (không chờ tạo đơn hàng DB).

### 3.3. Kiểm Tra Trạng Thái (Status Check)
- API `GET /seckill/status/:productId` cho phép client kiểm tra số lượng còn lại và trạng thái chiến dịch.
- Dữ liệu được đọc trực tiếp từ Redis, không truy vấn Database, đảm bảo phản hồi nhanh.

### 3.4. Cơ Chế Bù Trừ (Compensation / Release)
- Nếu quá trình tạo đơn hàng hoặc thanh toán thất bại ở các service phía sau, hệ thống cần trả lại slot (tồn kho) để người khác có thể mua.
- Service lắng nghe sự kiện `order.seckill.release`.
- Sử dụng Lua Script `seckill-release.lua` để:
  - Xóa user khỏi danh sách đã mua (`SREM`).
  - Tăng lại tồn kho (`INCR`).
  - Bắn sự kiện `seckill.released` xác nhận.

## 4. API Reference

### Public Endpoints
| Method | Endpoint | Mô tả | Auth |
|--------|----------|-------|------|
| `POST` | `/seckill/buy` | Yêu cầu mua hàng. Header `X-User-ID` là bắt buộc. | User |
| `GET` | `/seckill/status/:productId` | Lấy thông tin tồn kho và thời gian chiến dịch. | Public |

### Admin Endpoints
| Method | Endpoint | Mô tả | Auth |
|--------|----------|-------|------|
| `POST` | `/admin/seckill/init` | Khởi tạo chiến dịch mới. | Admin Key |
| `POST` | `/admin/seckill/release` | Thủ công giải phóng slot (nếu cần). | Admin Key |

## 5. Luồng Dữ Liệu (Data Flow) - Mua Hàng

1.  **User Request**: Client gọi `POST /seckill/buy`.
2.  **Gateway**: Xác thực JWT, thêm header `X-User-ID`.
3.  **Seckill Service**:
    *   Validate input.
    *   Chạy **Lua Script** trên Redis.
    *   **Nếu thất bại** (hết hàng, mua rồi, spam): Trả lỗi 409/429.
    *   **Nếu thành công**:
        *   Gửi message `seckill.order.won` vào Queue.
        *   Trả về `202 Accepted` kèm `orderId`.
4.  **Order Service** (Consumer):
    *   Nhận message `seckill.order.won`.
    *   Tạo đơn hàng trong Database (MySQL/Postgres).
    *   Nếu lỗi -> Gửi event `order.seckill.release` để hoàn kho.

## 6. Các Tính Năng Độ Tin Cậy (Reliability Features)

- **Ghost Order Fallback**: Nếu không thể gửi message lên Broker (do lỗi mạng/broker sập), service sẽ ghi log sự kiện vào file cục bộ (`logs/emergency-events.log`). Admin có thể chạy script để replay các đơn hàng này sau.
- **Idempotency**: API Release được thiết kế idempotent (thực hiện nhiều lần kết quả như nhau) để an toàn khi retry.
