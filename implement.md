# Deployment Plan: Multi-Node Architecture

Hệ thống sẽ được triển khai theo mô hình phân tán trên 3 Virtual Machine (VM) để tối ưu hóa hiệu năng, đặc biệt cho kịch bản Flash Sale với chiến thuật tách biệt "Worker vs State".

## 1. Overview Architecture

| Node | Vai trò | Đặc điểm | Services |
| :--- | :--- | :--- | :--- |
| **VM 1** | **Hot Node** (Mặt tiền) | Chịu tải cao nhất, xử lý request đầu vào & logic nhanh. | API Gateway, Seckill Service, Redis Seckill |
| **VM 2** | **Worker Node** (Nhà máy) | **Thay đổi lớn**: Gồm toàn bộ các Stateless Workers xử lý logic async nặng. | Order (x4), Inventory (x2), Payment (x2) |
| **VM 3** | **Infra Node** (Kho bãi) | Chứa hạ tầng, Database cache và các service ít write. | RabbitMQ, Redis Shared, Auth, Product, Jaeger |

---

## 2. Detailed Node Configuration

### 🟢 Node 1: Hot Node (Frontline)
*IP dự kiến: 10.148.0.5*
Đây là "cửa ngõ" và nơi diễn ra trận chiến Flash Sale. Mục tiêu: Cô lập luồng nóng, không cho ảnh hưởng đến các node khác.

1.  **Daddy Gateway** (`port: 3000` > `80`)
    *   Điểm duy nhất Public ra Internet.
    *   Route traffic đến Seckill (Local) và các service khác (qua Private IP).
2.  **Seckill Service** (`port: 3007`)
    *   Xử lý logic mua hàng Flash Sale (Rate limiting, Stock check).
    *   **Không dính dáng đến DB**, chỉ giao tiếp RAM với Redis.
3.  **Redis Seckill** (`port: 6380`)
    *   Dedicated Redis instance cho Seckill.
    *   Lưu trữ: Stock count, User lock, Rate limits.

---

### 🔵 Node 2: Worker Node (The Processing Plant)
*IP dự kiến: 10.148.0.6* (Máy 2 vCPU, 8GB RAM)
Đây là "Nhà máy" nơi các công nhân (Workers) cày ngày cày đêm. Toàn bộ logic xử lý đơn hàng phức tạp (Saga Pattern) nằm ở đây.

> Chiến thuật: Gom nhóm theo hành vi "Stateless Worker" (chỉ nhận message và xử lý), tách biệt khỏi nơi lưu trữ state (RabbitMQ/DB).

1.  **Order Service** (`port: 3002`) - **x4 Replicas**
    *   Tạo đơn, quản lý State Machine.
    *   Consume message từ RabbitMQ.
2.  **Inventory Service** (`port: 3005`) - **x2 Replicas**
    *   Chuyển nhà từ VM 3 sang đây.
    *   Nhiệm vụ: Trừ kho (Heavy Logic), giảm tải CPU cho VM 3.
3.  **Payment Service** (`port: 3006`) - **x2 Replicas**
    *   Chuyển nhà từ VM 3 sang đây.
    *   Nhiệm vụ: Xử lý thanh toán.

---

### 🟡 Node 3: Infra Node (Storage & Admin)
*IP dự kiến: 10.148.0.7*
Nơi chứa "Trái tim" (RabbitMQ) và "Bộ não" (Data/Auth) của hệ thống. Được giải phóng khỏi các worker nặng để đảm bảo I/O ổn định.

**A. Core Infrastructure**
1.  **RabbitMQ** (`port: 5672, 15672`)
    *   **Trái tim của hệ thống**. Giờ đây đã được "thở" vì không còn bị Inventory Service tranh chấp CPU.
    *   Đảm bảo routing tin nhắn mượt mà cho VM 2 xử lý.
2.  **Redis Shared** (`port: 6379`)
    *   Cache chung.
3.  **Jaeger** (`port: 4318, 16686`)
    *   Tracing logs.

**B. Read-Heavy / Admin Services**
1.  **Auth Service** (`port: 3001`): Ít write, chủ yếu verify token.
2.  **Product Service** (`port: 3004`): Chủ yếu là Read, cache nhiều.
3.  **Nginx Internal** (`port: 80`): Routing nội bộ cho Auth/Product.

---

## 3. Communication Flow (Luồng đi mới)

1.  **Flash Sale Flow**:
    *   User -> **VM 1** (Seckill) -> Check Redis (Local).
    *   Thắng -> **VM 1** bắn tin nhắn -> **VM 3** (RabbitMQ).
    *   **VM 3** (RabbitMQ) đẩy việc -> **VM 2** (Order/Inventory Worker).
    *   **VM 2** xử lý xong -> Update DB (External).

2.  **Lợi ích của mô hình này**:
    *   **RabbitMQ an toàn**: Không bao giờ bị nghẽn do worker chiếm dụng CPU.
    *   **Scale dễ dàng**: Nếu xử lý chậm, chỉ cần add thêm container vào **VM 2** (hoặc mở rộng VM 2) mà không ảnh hưởng cấu trúc mạng.
    *   **Chia để trị**: VM 1 lo hứng đạn, VM 2 lo cày ải, VM 3 lo điều phối.

---

## 4. Next Steps
1.  **Cập nhật `docker-compose.cold-node.yml`**: Thêm Inventory và Payment vào đây, tăng replica count.
2.  **Cập nhật `docker-compose.infras.yml`**: Xóa Inventory và Payment, chỉ giữ lại RabbitMQ, Redis, Auth, Product.
3.  **Kiểm tra Resource**: Đảm bảo VM 2 đủ RAM cho 8 containers nodejs.
