| Version | Date | Author | Description |
| :--- | :--- | :--- | :--- |
| 0.1 | 14/11/2025 | HungDz | Bản dự thảo đầu tiên |
| 0.2 | 14/11/2025 | HungDz | Cập nhật khớp với implementation thực tế |
| 0.3 | 14/11/2025 | HungDz | Thêm Circuit Breaker pattern và mở rộng Outbox cho tất cả services |

## 1\. Giới thiệu

### 1.1. Mục đích

Tài liệu này đặc tả các yêu cầu chức năng và phi chức năng cho **Hệ thống Backend E-commerce** (sau đây gọi là "Hệ thống").

Mục tiêu của hệ thống là xử lý các đơn đặt hàng trực tuyến một cách tin cậy, có khả năng mở rộng và dễ bảo trì thông qua việc áp dụng mô hình Microservices, **Saga Pattern** và **Transactional Outbox**.

### 1.2. Phạm vi

Hệ thống bao gồm **7 services** (6 microservices nghiệp vụ + 1 API Gateway) và các thành phần hạ tầng hỗ trợ. Phạm vi của tài liệu này bao gồm:

  * **Services:**
    1.  `API Gateway` (Port 3003) - Điểm vào duy nhất, xử lý authentication, routing
    2.  `Auth Service` (Port 3001) - Xác thực người dùng, quản lý JWT tokens
    3.  `Order Service` (Port 3002) - Quản lý đơn hàng, điều phối Saga
    4.  `Product Service` (Port 3004) - Quản lý catalog sản phẩm, validation
    5.  `Inventory Service` (Port 3005) - Quản lý tồn kho, reserve/release
    6.  `Payment Service` (Event-driven) - Xử lý thanh toán
    7.  `Notification Service` (Event-driven) - Gửi thông báo cho người dùng
  * **Shared Packages:**
    - `@ecommerce/message-broker` - RabbitMQ wrapper với retry/DLQ
    - `@ecommerce/outbox-pattern` - Transactional Outbox implementation cho tất cả services
    - `@ecommerce/logger` - Structured logging với Pino
    - `@ecommerce/config` - Centralized configuration management
    - `@ecommerce/tracing` - OpenTelemetry distributed tracing
    - `@ecommerce/circuit-breaker` - Circuit Breaker pattern với state management (CLOSED/OPEN/HALF_OPEN)
  * **Giao diện bên ngoài:** API Gateway (Port 3003) cho các yêu cầu từ Client.
  * **Luồng nghiệp vụ:** Luồng xử lý Saga cho việc tạo và xác nhận đơn hàng, bao gồm cả các kịch bản thành công và thất bại (compensation).

### 1.3. Định nghĩa và Viết tắt

| Thuật ngữ | Định nghĩa |
| :--- | :--- |
| **Saga** | Một chuỗi các giao dịch cục bộ. Khi một giao dịch thất bại, Saga sẽ thực thi các giao dịch bù trừ (compensation) để hoàn tác. |
| **Outbox** | (Transactional Outbox) Một pattern để đảm bảo tin nhắn được gửi đi (at-least-once) bằng cách lưu event vào DB trong cùng một transaction với nghiệp vụ. |
| **CDC** | (Change Data Capture) Kỹ thuật theo dõi và bắt các thay đổi dữ liệu trong database (ví dụ: MongoDB Change Streams). |
| **DLQ** | (Dead Letter Queue) Một hàng đợi để chứa các tin nhắn không thể xử lý được (poison messages) để phân tích thủ công. |
| **Idempotency** | Đảm bảo rằng việc xử lý một tin nhắn nhiều lần không làm thay đổi kết quả sau lần xử lý đầu tiên. |

### 1.4. Tổng quan tài liệu

Tài liệu này được tổ chức như sau:

  * **Chương 2:** Mô tả tổng quan về hệ thống, các bên liên quan và các ràng buộc.
  * **Chương 3:** Đặc tả chi tiết các yêu cầu chức năng, sắp xếp theo từng service và luồng nghiệp vụ.
  * **Chương 4:** Đặc tả các yêu cầu phi chức năng (hiệu năng, bảo mật, khả năng quan sát, v.v.).
  * **Phụ lục:** Chi tiết về API, danh sách Events, và State Machine.

-----

## 2\. Mô tả tổng quan

### 2.1. Bối cảnh sản phẩm

Hệ thống là một phần của nền tảng e-commerce lớn hơn, chịu trách nhiệm cho toàn bộ vòng đời của một đơn hàng, từ lúc khách hàng khởi tạo cho đến khi được xác nhận hoặc hủy.

Hệ thống được thiết kế để tách biệt (decoupled), cho phép các service `Inventory`, `Payment`, và `Notification` hoạt động độc lập và giao tiếp bất đồng bộ qua **RabbitMQ**.

### 2.2. Chức năng sản phẩm

Chức năng cốt lõi của hệ thống bao gồm:

1.  Tiếp nhận yêu cầu tạo đơn hàng mới.
2.  Điều phối luồng nghiệp vụ: Kiểm tra tồn kho (Inventory), xử lý thanh toán (Payment).
3.  Xác nhận đơn hàng nếu tất cả các bước thành công.
4.  Tự động thực hiện bù trừ (compensation) nếu có bất kỳ bước nào thất bại (ví dụ: hoàn trả stock nếu thanh toán lỗi).
5.  Gửi thông báo cho người dùng về trạng thái đơn hàng.

### 2.3. Đặc điểm người dùng (Users)

  * **End-User (Khách hàng):** Tương tác với hệ thống một cách gián tiếp thông qua một ứng dụng Client (Web/Mobile) để tạo đơn hàng, đăng nhập, đăng ký và xem trạng thái đơn hàng.
  * **Administrator (Dev):** Là nhóm phát triển (developer), chịu trách nhiệm vận hành, giám sát hệ thống (Grafana, Jaeger) và xử lý các sự cố (như DLQ).

### 2.4. Ràng buộc

1.  **Công nghệ:** Hệ thống PHẢI sử dụng các công nghệ sau:
      * **MongoDB** với Replica Set (tối thiểu 3 nodes: 1 primary + 2 secondary) để hỗ trợ transactions với Write Concern: `majority`, Read Concern: `majority`.
      * **RabbitMQ** (làm message broker) với **Topic Exchange** (`ecommerce.events`) và DLQ (Dead Letter Queue) configuration.
      * **Redis** (cho Idempotency checking với TTL 24 hours).
      * **OpenTelemetry** (cho distributed tracing).
      * **Prometheus** (cho metrics collection) và **Grafana** (cho dashboards visualization).
      * **Jaeger** (cho trace visualization).
2.  **Giao thức:** 
      * Giao tiếp bất đồng bộ giữa các services PHẢI thông qua RabbitMQ **Topic Exchange với routing keys** theo format `{service}.{entity}.{action}`.
      * Chỉ `API Gateway`, `Auth Service`, `Order Service` và `Product Service` được phép expose HTTP API.
      * `Inventory Service`, `Payment Service`, `Notification Service` là event-driven (no public HTTP endpoints, chỉ consume từ RabbitMQ).
3.  **Pattern:** 
      * PHẢI áp dụng **Transactional Outbox Pattern** với MongoDB Change Streams cho **tất cả services cần publish events** (`Order Service`, `Inventory Service`, `Payment Service`) để đảm bảo at-least-once delivery.
      * PHẢI implement **Idempotency** sử dụng Redis để tránh xử lý trùng lặp events.
      * PHẢI có **Circuit Breaker** (từ shared package `@ecommerce/circuit-breaker`) cho tất cả synchronous calls giữa các services (Order → Product, và bất kỳ HTTP call nào khác).

### 2.5. Giả định và Phụ thuộc

1.  **Giả định:** Môi trường hạ tầng (RabbitMQ, MongoDB, Redis) đã được cài đặt và cấu hình sẵn sàng.
2.  **Phụ thuộc (Client):** Hệ thống phụ thuộc vào một Client (không thuộc phạm vi dự án này) để gửi yêu cầu.
3.  **Phụ thuộc (Internal):** `Order Service` phụ thuộc **đồng bộ (synchronously)** vào `Product Service` để kiểm tra thông tin sản phẩm và giá cả trước khi khởi tạo Saga.

-----

## 3\. Yêu cầu chức năng (Functional Requirements)

### 3.1. FR-GW: API Gateway

  * **FR-GW.1:** API Gateway PHẢI đóng vai trò là điểm vào (entrypoint) duy nhất cho tất cả các request từ Client.
  * **FR-GW.2:** API Gateway PHẢI xác thực **JWT (Access Token)** trong header của mọi request gửi đến các endpoint được bảo vệ (ví dụ: `POST /orders`).
  * **FR-GW.3:** Nếu token không hợp lệ hoặc hết hạn, API Gateway PHẢI trả về lỗi `401 Unauthorized`.
  * **FR-GW.4:** API Gateway PHẢI chuyển tiếp (forward) các request hợp lệ đến các service tương ứng (Auth, Order, Product).

### 3.2. FR-AUTH: Service Xác thực (Auth Service)

  * **FR-AUTH.1:** Service PHẢI cung cấp endpoint `POST /auth/register` để người dùng mới tạo tài khoản.
  * **FR-AUTH.2:** Service PHẢI cung cấp endpoint `POST /auth/login` để xác thực người dùng và trả về một cặp `access_token` (JWT) và `refresh_token`.
  * **FR-AUTH.3:** Service PHẢI cung cấp endpoint `POST /auth/refresh` để nhận `refresh_token` hợp lệ và cấp mới một `access_token`.

### 3.3. FR-PRODUCT: Service Sản phẩm (Product Service)

  * **FR-PRODUCT.1:** Service PHẢI cung cấp **internal API** `POST /api/products/validate` để `Order Service` kiểm tra danh sách sản phẩm.
  * **FR-PRODUCT.2:** Endpoint validation PHẢI:
    - **Input:** `{ "products": [{ "productId": "string", "quantity": number }] }`
    - **Authentication:** Service-to-Service API Key (header `X-API-Key`)
    - **Validation:** Kiểm tra sự tồn tại, trạng thái active của từng product
    - **Output (Success):** 
      ```json
      {
        "valid": true,
        "items": [
          { "productId": "...", "name": "...", "price": 100, "quantity": 2 }
        ],
        "totalPrice": 200
      }
      ```
    - **Output (Failure):**
      ```json
      {
        "valid": false,
        "errors": ["Product ABC not found", "Product XYZ inactive"]
      }
      ```
  * **FR-PRODUCT.3:** Service CÓ THỂ cung cấp public API như `GET /api/products`, `GET /api/products/{id}` cho Client (optional).
  * **FR-PRODUCT.4:** Service PHẢI implement rate limiting: 100 requests/15 minutes per IP cho public endpoints.

### 3.4. FR-ORDER: Service Đơn hàng (Order Service)

  * **FR-ORDER.1:** Khi nhận yêu cầu `POST /orders/api/v1/orders`, `Order Service` PHẢI **gọi đồng bộ (synchronous) đến `Product Service`** với Circuit Breaker để:
    1.  Xác thực tất cả `productId` trong giỏ hàng đều tồn tại.
    2.  Lấy giá của các sản phẩm.
    3.  Tính toán tổng giá trị đơn hàng (`totalPrice`).
  * **FR-ORDER.1a:** **(Circuit Breaker)** Nếu Product Service không khả dụng (Circuit OPEN), PHẢI trả về `503 Service Unavailable` cho Client.
  * **FR-ORDER.2:** **(Failure Path)** Nếu bất kỳ `productId` nào không tồn tại, `Order Service` PHẢI trả về lỗi `400 Bad Request` (hoặc 404) cho Client và **KHÔNG** khởi tạo Saga.
  * **FR-ORDER.3:** **(Happy Path)** Nếu kiểm tra sản phẩm thành công, `Order Service` PHẢI:
    1.  Tạo một bản ghi `Order` với status `PENDING` và `totalPrice` đã tính.
    2.  Tạo một bản ghi `Outbox` (status: `PENDING`) chứa payload của event `ORDER_CREATED`.
    3.  Cả hai thao tác trên PHẢI nằm trong cùng một MongoDB Transaction.
    4.  Trả về `201 Created` với `orderId` và status `PENDING` ngay lập tức cho Client.
  * **FR-ORDER.4:** (Outbox) Service PHẢI sử dụng `@ecommerce/outbox-pattern` package với MongoDB Change Streams để theo dõi và publish events lên RabbitMQ.
  * **FR-ORDER.5:** (Consumer) Khi nhận event `PAYMENT_SUCCEEDED`, `Order Service` PHẢI cập nhật status của Order thành `CONFIRMED`.
  * **FR-ORDER.6:** (Consumer) Khi nhận event `STOCK_REJECTED` hoặc `PAYMENT_FAILED`, `Order Service` PHẢI cập nhật status của Order thành `CANCELLED`.
  * **FR-ORDER.7:** Khi nhận yêu cầu `GET /orders/{id}`, `Order Service` PHẢI trả về trạng thái hiện tại của đơn hàng.

### 3.5. FR-INV: Service Kho hàng (Inventory Service)

  * **FR-INV.1:** (Consumer) Service PHẢI subscribe queue `inventory.events` với routing keys:
    - `order.inventory.reserve` - Yêu cầu reserve stock từ Order Service
    - `order.inventory.release` - Yêu cầu release stock từ Order Service
    - `product.product.created` - Tạo inventory record cho product mới
    - `product.product.deleted` - Xóa inventory record khi product bị xóa
  * **FR-INV.2:** (Processing) Khi nhận event với routing key `order.inventory.reserve`, `Inventory Service` PHẢI:
    1.  Kiểm tra tồn kho cho `productId` trong payload.
    2.  **Nếu đủ hàng:** Trừ (reserve) số lượng stock.
    3.  Publish event với routing key `inventory.order.reserved` hoặc `inventory.order.reserve_failed` qua `@ecommerce/message-broker`.
    4.  Các thao tác PHẢI được xử lý với idempotency check (Redis).
  * **FR-INV.3:** (Compensation) Khi nhận event với routing key `order.inventory.release`, `Inventory Service` PHẢI:
    1.  Tìm các stock đã reserve cho `orderId` đó.
    2.  Hoàn trả (release) số lượng stock (stock += quantity).
    3.  Log việc release thành công.
  * **FR-INV.4:** Service KHÔNG được cung cấp public HTTP API (chỉ event-driven via RabbitMQ).
  * **FR-INV.5:** Service PHẢI expose HTTP server (port 3005) cho health checks và internal management.

### 3.6. FR-PAYMENT: Service Thanh toán (Payment Service)

  * **FR-PAYMENT.1:** (Consumer) Khi nhận event `ORDER_CONFIRMED` (tất cả inventory reserved), `Payment Service` PHẢI:
    1.  Mô phỏng việc xử lý thanh toán (có thể gọi payment gateway bên thứ ba).
    2.  Tạo bản ghi Outbox chứa event `PAYMENT_COMPLETED` hoặc `PAYMENT_FAILED`.
    3.  Các thao tác PHẢI nằm trong MongoDB Transaction.
  * **FR-PAYMENT.2:** (Outbox) Service PHẢI sử dụng `@ecommerce/outbox-pattern` package để publish events lên RabbitMQ.
  * **FR-PAYMENT.3:** Service KHÔNG được cung cấp public HTTP API (event-driven only).
  * **FR-PAYMENT.4:** Service PHẢI expose HTTP server cho health checks.

### 3.7. FR-NOTIF: Service Thông báo (Notification Service)

  * **FR-NOTIF.1:** (Consumer) Khi nhận event `ORDER_CONFIRMED_NOTIFICATION`, service PHẢI gửi email/SMS thông báo đơn hàng thành công cho customer.
  * **FR-NOTIF.2:** (Consumer) Khi nhận event `ORDER_CANCELLED_NOTIFICATION`, service PHẢI gửi thông báo đơn hàng đã bị hủy.
  * **FR-NOTIF.3:** Service KHÔNG được cung cấp public HTTP API.
  * **FR-NOTIF.4:** Service PHẢI log mọi notification đã gửi với timestamp và delivery status.

### 3.8. FR-SAGA: Luồng nghiệp vụ (State Machine)

Hệ thống PHẢI tuân thủ state machine của Order Status:

  * `PENDING` → `CONFIRMED` (khi tất cả inventory reserved thành công)
  * `PENDING` → `PAID` (khi nhận `PAYMENT_COMPLETED`)
  * `PENDING` → `CANCELLED` (khi nhận `INVENTORY_RESERVE_FAILED` hoặc `PAYMENT_FAILED`)
  * Hệ thống KHÔNG cho phép transition từ `CONFIRMED` hoặc `PAID` → `CANCELLED` (final states).

-----

## 4\. Yêu cầu phi chức năng (Non-Functional Requirements)

### 4.1. NFR-PERF: Hiệu năng (Performance)

  * **NFR-PERF.1:** Thời gian phản hồi của `POST /orders` (trả về 201) PHẢI < 100ms (P95).
  * **NFR-PERF.2:** Tổng thời gian xử lý E2E của Saga (từ lúc tạo order đến lúc `CONFIRMED`) PHẢI < 500ms (P95).
  * **NFR-PERF.3:** Latency của từng bước Saga (ví dụ: `order_to_inventory`) PHẢI < 100ms (P95).
  * **NFR-PERF.4:** **(Mục tiêu tải)** Hệ thống PHẢI chịu được tải với các scenario sau:
    - **Scenario:** 50 Virtual Users (VUs) 
    - **Duration:** 1 phút liên tục
    - **Ramp-up:** 0→50 VUs trong 10 giây
    - **Mix:** 90% happy path, 5% out-of-stock, 5% payment failed
    - **Expected:** ~3000 total requests
    - **SLA:** Tỷ lệ lỗi < 1%, queue depth < 50, P95 latency < 500ms
    - **Resources:** CPU < 70%, Memory < 80%, Disk I/O < 60%

### 4.2. NFR-RES: Độ tin cậy & Khả năng phục hồi (Resilience)

  * **NFR-RES.1:** (At-least-once) Hệ thống PHẢI đảm bảo mọi event nghiệp vụ được publish ít nhất một lần thông qua Transactional Outbox Pattern cho **tất cả services** (`Order`, `Inventory`, `Payment`).
  * **NFR-RES.2:** (Idempotency) Tất cả các consumer PHẢI implement idempotency checking:
    - **Mechanism:** Redis với key format `processed:{serviceName}:{eventId}`
    - **TTL:** 24 hours
    - **Race Condition:** Sử dụng `SET NX` (only if not exists) để tránh duplicate processing
    - **Example:** `processed:inventory:f47ac10b-58cc-4372-a567-0e02b2c3d479`
  * **NFR-RES.3:** (Compensation) Hệ thống PHẢI tự động rollback (release stock) khi `PAYMENT_FAILED`.
  * **NFR-RES.4:** (DLQ) Dead Letter Queue PHẢI được cấu hình:
    - **Queue Name:** `events.dlq`
    - **Trigger:** Sau 3 lần retry thất bại
    - **Alert:** Immediate notification khi DLQ depth > 0
    - **Replay:** Manual via RabbitMQ Management UI
    - **Retention:** 7 days (configurable)
  * **NFR-RES.5:** (Retry) Hệ thống PHẢI có cơ chế retry với exponential backoff:
    - Retry 1: sau 5s
    - Retry 2: sau 15s
    - Retry 3: sau 30s
    - Sau đó → DLQ
  * **NFR-RES.6:** (Circuit Breaker) Tất cả synchronous HTTP calls PHẢI sử dụng Circuit Breaker với cấu hình:
    - **Failure Threshold:** 5 failures (số lần thất bại để mở circuit)
    - **Success Threshold:** 2 successes (số lần thành công để đóng circuit từ HALF_OPEN)
    - **Timeout:** 3000ms (request timeout)
    - **Reset Timeout:** 30000ms (thời gian chờ trước khi chuyển từ OPEN → HALF_OPEN)
    - **States:** CLOSED (normal) → OPEN (fail-fast) → HALF_OPEN (test recovery)
    - **Metrics:** Expose `circuit_breaker_state{service="order",target="product"}` gauge metric

### 4.3. NFR-OBS: Khả năng quan sát (Observability)

  * **NFR-OBS.1:** (Tracing) Tất cả request/event PHẢI được trace bằng OpenTelemetry:
    - **Trace propagation:** W3C Trace Context standard
    - **Sampling:** 100% trong development, 10% trong production
    - **Exporter:** Jaeger (http://localhost:4318/v1/traces)
  * **NFR-OBS.2:** (Logging) Tất cả log PHẢI chứa `traceId` và `spanId` để correlation. Format: Structured JSON (Pino) với pino-pretty trong development.
  * **NFR-OBS.3:** (Metrics) Hệ thống PHẢI export các metrics sau:
      * `saga_started_total` (Counter) - Tổng số saga bắt đầu
      * `saga_completed_total{status="confirmed|cancelled"}` (Counter) - Saga hoàn thành
      * `saga_failed_total` (Counter) - Saga thất bại
      * `saga_step_latency_seconds{step="order_to_inventory|inventory_to_payment"}` (Histogram)
      * `saga_e2e_latency_seconds` (Histogram)
      * `rabbitmq_queue_messages_ready{queue="order.events|inventory.events|payment.events"}` (Gauge)
      * `rabbitmq_messages_published_total{routing_key}` (Counter) - Messages published by routing key
      * `rabbitmq_messages_consumed_total{queue,routing_key}` (Counter) - Messages consumed by queue and routing key
      * `outbox_pending_count{service="order|inventory|payment"}` (Gauge)
      * `inventory_stock_reserved` (Counter)
      * `payment_transactions_total{status="success|failed"}` (Counter)
      * `notification_sent_total{type="email|sms"}` (Counter)
      * `circuit_breaker_state{service="order",target="product"}` (Gauge: 0=CLOSED, 1=OPEN, 2=HALF_OPEN)
      * `circuit_breaker_calls_total{service,target,status="success|failure|rejected"}` (Counter)
  * **NFR-OBS.4:** (Alerting) Hệ thống PHẢI cấu hình alerts:
      * `HighQueueDepth`: Queue depth > 100 messages
      * `PoisonMessage`: DLQ depth > 0 (Critical)
      * `HighFailureRate`: Saga failed rate > 5% trong 5 phút
      * `OutboxStuck`: Outbox pending > 1 giờ
      * `SlowSaga`: P95 E2E latency > 1 giây
      * `CircuitBreakerOpen`: Circuit state = OPEN trong > 1 phút (Critical)

### 4.4. NFR-SEC: Bảo mật (Security)

  * **NFR-SEC.1:** (Authentication) API Gateway PHẢI validate JWT cho protected endpoints:
    - **Algorithm:** HS256 hoặc RS256
    - **Claims:** `userId`, `email`, `role`, `exp`, `iat`
    - **Token Location:** `Authorization: Bearer <token>` header
  * **NFR-SEC.2:** Các endpoint public (`/auth/login`, `/auth/register`) KHÔNG yêu cầu JWT.
  * **NFR-SEC.3:** (Rate Limiting) PHẢI implement rate limiting:
    - **Auth endpoints:** 5 requests/15 minutes per IP (login/register)
    - **Order endpoints:** 100 requests/15 minutes per IP
    - **Public endpoints:** 200 requests/15 minutes per IP
  * **NFR-SEC.4:** (Input Validation) Tất cả input PHẢI được validate:
    - **Schema:** Sử dụng Joi/Zod schema validation
    - **Sanitization:** Remove/escape malicious input (XSS, SQL injection)
    - **Max sizes:** Request body < 1MB, Array length < 100 items
  * **NFR-SEC.5:** (Service-to-Service Auth) Internal API calls PHẢI sử dụng:
    - **Mechanism:** API Keys trong header `X-API-Key`
    - **Storage:** Environment variables, rotated monthly
    - **Example:** Order → Product validation call
  * **NFR-SEC.6:** (CORS) API Gateway PHẢI config CORS cho production:
    - **Allowed Origins:** Whitelist specific domains
    - **Methods:** GET, POST, PUT, DELETE, OPTIONS
    - **Headers:** Authorization, Content-Type, X-Request-ID

-----

## 5\. Yêu cầu Giao diện ngoài (Interface Requirements)

### 5.1. API (Phía Client)

  * **Auth Service:**
      * `POST /auth/api/v1/register`
      * `POST /auth/api/v1/login`
      * `POST /auth/api/v1/refresh`
  * **Order Service:**
      * `POST /api/orders` (Body: `{ "products": [{ "productId": "string", "quantity": number }] }`)
      * `GET /api/orders/{id}`
  * **Product Service:**
      * `GET /api/products` (Public: List all products)
      * `GET /api/products/{id}` (Public: Get product details)
      * `POST /api/products/validate` (Internal: Validate products for Order Service)
        - **Authentication:** Service-to-Service API Key (`X-API-Key` header)
        - **Request:** `{ "products": [{ "productId": "string", "quantity": number }] }`
        - **Response:** `{ "valid": boolean, "items": [...], "totalPrice": number }`

### 5.2. Giao diện Bất đồng bộ (Events)

Hệ thống PHẢI sử dụng **Topic Exchange** `ecommerce.events` với các routing keys sau:

#### **Routing Key Convention:** `{service}.{entity}.{action}`

| Routing Key | Event Type (Legacy) | Producer | Consumer Queue | Consumers |
| :--- | :--- | :--- | :--- | :--- |
| `order.inventory.reserve` | RESERVE | Order Service (Outbox) | `inventory.events` | Inventory |
| `order.inventory.release` | RELEASE | Order Service (Outbox) | `inventory.events` | Inventory |
| `inventory.order.reserved` | INVENTORY_RESERVED | Inventory Service | `order.events` | Order |
| `inventory.order.reserve_failed` | INVENTORY_RESERVE_FAILED | Inventory Service | `order.events` | Order |
| `order.order.confirmed` | ORDER_CONFIRMED | Order Service (Outbox) | `payment.events`, `notification.events` | Payment, Notification |
| `order.order.cancelled` | ORDER_CANCELLED | Order Service (Outbox) | `notification.events` | Notification |
| `order.order.paid` | ORDER_PAID | Order Service (Outbox) | `notification.events` | Notification |
| `payment.order.completed` | PAYMENT_COMPLETED | Payment Service | `order.events`, `notification.events` | Order, Notification |
| `payment.order.failed` | PAYMENT_FAILED | Payment Service | `order.events`, `notification.events` | Order, Notification |
| `product.product.created` | PRODUCT_CREATED | Product Service | `inventory.events` | Inventory |
| `product.product.deleted` | PRODUCT_DELETED | Product Service | `inventory.events` | Inventory |

#### **Queue Bindings with Wildcards:**

| Queue | Bound Routing Keys | Description |
| :--- | :--- | :--- |
| `order.events` | `order.#`, `inventory.order.#`, `payment.order.#` | Tất cả order events và responses từ inventory/payment |
| `inventory.events` | `order.inventory.#`, `product.product.#` | Reserve/release requests và product lifecycle events |
| `payment.events` | `order.order.confirmed` | Order confirmed events để xử lý thanh toán |
| `notification.events` | `order.order.#`, `payment.order.#` | Tất cả order và payment events để gửi thông báo |

**Note:** 
- Mọi event PHẢI chứa metadata: `eventId` (UUID), `correlationId` (orderId), `timestamp`.
- Routing key được inject vào message headers (`x-routing-key`) để tracking.
- Wildcard patterns: `*` (1 word), `#` (0 hoặc nhiều words).

-----

## 6\. Phụ lục A: Sơ đồ Kiến trúc

```
┌─────────────┐
│ API Gateway │ (Port 3003)
└──────┬──────┘
       │
       ├──────────────────────────────────────────────┐
       │                                              │
       ▼                                              ▼
┌─────────────┐                              ┌──────────────┐
│ Auth Service│ (Port 3001)                  │Order Service │ (Port 3002)
│   + JWT     │                              │  + Outbox    │
└─────────────┘                              │  + Change    │
                                             │    Stream    │
                                             └──────┬───────┘
                                                    │
                      ┌─────────────────────────────┼─────────────────────┐
                      │                             │                     │
                      ▼                             ▼                     ▼
              ┌──────────────┐          ┌─────────────────┐    ┌──────────────┐
              │   Product    │          │   Inventory     │    │ Notification │
              │   Service    │          │    Service      │    │   Service    │
              │ (Port 3004)  │          │  (Port 3005)    │    │(Event-driven)│
              │ + Validation │          │  (Event-driven) │    │(Event-driven)│
              └──────────────┘          └─────────────────┘    └──────────────┘
                                                   │
                                                   ▼
                                        ┌─────────────────┐
                                        │ Payment Service │
                                        │ (Event-driven)  │
                                        └─────────────────┘
                               
                      ───────────── RabbitMQ (Events + DLQ) ─────────────
                      
        Infrastructure: 
        - MongoDB (Replica Set with Change Streams)
        - Redis (Idempotency TTL 24h)
        - Jaeger (Distributed Tracing)
        - Prometheus (Metrics) + Grafana (Dashboards)
        
        Shared Packages:
        - @ecommerce/message-broker (RabbitMQ wrapper)
        - @ecommerce/outbox-pattern (Transactional Outbox)
        - @ecommerce/logger (Pino structured logging)
        - @ecommerce/config (Centralized config)
        - @ecommerce/tracing (OpenTelemetry)
```

-----

## 7\. Phụ lục B: Luồng Sequence (Tóm tắt)

  * **Pre-Saga:** Client → API Gateway (Validate JWT) → Order Service → **Product Service (Sync Validate Products + Prices)**.
      * *Nếu validation fail:* Order Service → `400 Bad Request` cho Client.
      * *Nếu validation success:* Order Service → `201 Created` (Saga bắt đầu).
  * **Happy Path (All Products Reserved):** 
    1. Order Service → Outbox (`RESERVE` events) → RabbitMQ → Inventory Service
    2. Inventory → Reserve stock → Publish `INVENTORY_RESERVED` → Order Service
    3. Order → Update status `CONFIRMED` → Publish `ORDER_CONFIRMED`
    4. Payment Service → Process payment → Publish `PAYMENT_COMPLETED`
    5. Order → Update status `PAID` → Publish notification events
  * **Compensation (Out of Stock):** 
    1. Order → Outbox (`RESERVE`) → Inventory
    2. Inventory → Check stock → **NOT ENOUGH** → Publish `INVENTORY_RESERVE_FAILED`
    3. Order → Update status `CANCELLED` → Publish `ORDER_CANCELLED_NOTIFICATION`
  * **Compensation (Payment Failed):** 
    1. Order → Inventory → Reserve OK → Order `CONFIRMED`
    2. Payment Service → Process → **FAIL** → Publish `PAYMENT_FAILED`
    3. Order → Update status `CANCELLED` → Publish `RELEASE` events
    4. Inventory → Release reserved stock

-----

## 8\. Phụ lục C: Outbox Pattern Implementation

### C.1. Outbox Schema (MongoDB Collection)
```javascript
{
  _id: ObjectId,
  eventId: UUID,              // Unique event identifier
  eventType: String,          // Legacy: 'RESERVE', 'ORDER_CONFIRMED', etc.
  routingKey: String,         // NEW: 'order.inventory.reserve', 'order.order.confirmed', etc.
  payload: Object,            // Event data
  status: String,             // 'PENDING' | 'PROCESSED' | 'FAILED'
  retryCount: Number,         // Current retry attempts
  correlationId: String,      // OrderId for tracing
  createdAt: Date,
  processedAt: Date,          // When successfully published
  error: String               // Last error message if failed
}
```

**Routing Key Mapping:** OutboxProcessor tự động convert `eventType` → `routingKey`:
```javascript
const routingKeyMap = {
  'RESERVE': 'order.inventory.reserve',
  'RELEASE': 'order.inventory.release',
  'ORDER_CONFIRMED': 'order.order.confirmed',
  'ORDER_CANCELLED': 'order.order.cancelled',
  'PRODUCT_CREATED': 'product.product.created',
  // ... etc
};
```

### C.2. Change Stream Configuration
```javascript
// Watch only PENDING events
const changeStream = outboxCollection.watch([
  { $match: { 'fullDocument.status': 'PENDING' } }
]);

changeStream.on('change', async (change) => {
  const event = change.fullDocument;
  await publishToRabbitMQ(event);
  await markAsProcessed(event._id);
});
```

### C.3. Processor Retry Logic
- **Max Retries:** 3 attempts
- **Backoff:** 5s, 15s, 30s
- **Permanent Failure:** Mark status as `FAILED`, alert admin
- **Transient Error:** Increment retryCount, keep status `PENDING`

### C.4. Multi-Service Implementation
Các services sau PHẢI implement Transactional Outbox Pattern:
1. **Order Service:** Publish `RESERVE`, `ORDER_CONFIRMED`, `ORDER_CANCELLED`, `RELEASE`, `ORDER_PAID`
2. **Inventory Service:** Publish `INVENTORY_RESERVED`, `INVENTORY_RESERVE_FAILED`
3. **Payment Service:** Publish `PAYMENT_COMPLETED`, `PAYMENT_FAILED`

Mỗi service PHẢI có:
- Collection `outbox` riêng trong database của service đó
- Change Stream processor chạy độc lập
- Idempotency check trước khi xử lý incoming events

-----

## 9\. Phụ lục D: Circuit Breaker Pattern

### D.1. Mục đích
Circuit Breaker pattern bảo vệ hệ thống khỏi cascade failures khi downstream service không khả dụng, giúp:
- **Fail-fast:** Trả về lỗi ngay lập tức thay vì chờ timeout
- **Resource Protection:** Tránh lãng phí threads/connections
- **Auto-recovery:** Tự động kiểm tra và khôi phục kết nối

### D.2. State Machine

```
┌─────────┐  Failure >= Threshold   ┌──────┐
│ CLOSED  │ ─────────────────────> │ OPEN │
│(Normal) │                         │(Fail)│
└────┬────┘                         └───┬──┘
     │                                  │
     │ Success >= Threshold             │ Reset Timeout
     │                                  │ Elapsed
     │                              ┌───▼────────┐
     └───────────────────────────── │ HALF_OPEN  │
                                    │  (Testing) │
                                    └────────────┘
```

**States:**
- **CLOSED (0):** Circuit đóng, tất cả requests được thực thi bình thường. Track failure count.
- **OPEN (1):** Circuit mở, tất cả requests bị reject ngay lập tức với lỗi `503 Service Unavailable`. Không gọi downstream service.
- **HALF_OPEN (2):** Cho phép một số requests (test requests) đi qua để kiểm tra xem service đã hồi phục chưa. Nếu thành công → CLOSED, nếu thất bại → OPEN.

### D.3. Configuration Schema

```javascript
// @ecommerce/circuit-breaker package
{
  failureThreshold: 5,        // Số lần thất bại liên tiếp để mở circuit
  successThreshold: 2,        // Số lần thành công để đóng circuit từ HALF_OPEN
  timeout: 3000,              // Request timeout (ms)
  resetTimeout: 30000,        // Thời gian chờ trước khi chuyển OPEN → HALF_OPEN (ms)
  name: 'order-to-product',   // Tên circuit cho monitoring
  onOpen: (error) => {        // Callback khi circuit mở
    logger.error('Circuit opened', { error });
  },
  onHalfOpen: () => {         // Callback khi chuyển sang HALF_OPEN
    logger.info('Circuit half-open, testing...');
  },
  onClose: () => {            // Callback khi circuit đóng
    logger.info('Circuit closed');
  }
}
```

### D.4. API Usage

```javascript
const CircuitBreaker = require('@ecommerce/circuit-breaker');

// Khởi tạo
const productServiceBreaker = new CircuitBreaker({
  name: 'order-to-product',
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 3000,
  resetTimeout: 30000
});

// Sử dụng
try {
  const result = await productServiceBreaker.execute(async () => {
    // Synchronous call đến Product Service
    return await axios.post('http://product-service:3004/api/products/validate', {
      products: orderItems
    });
  });
  
  // result chứa response từ Product Service
  console.log('Product validation:', result.data);
  
} catch (error) {
  if (error.name === 'CircuitBreakerOpenError') {
    // Circuit đang OPEN, service không khả dụng
    return res.status(503).json({ 
      error: 'Product service temporarily unavailable. Please try again later.' 
    });
  }
  // Xử lý các lỗi khác (timeout, network, etc.)
  throw error;
}
```

### D.5. Error Handling

Circuit Breaker PHẢI throw các error types sau:

| Error Type | Khi nào | HTTP Status | Client Action |
|:-----------|:--------|:------------|:--------------|
| `CircuitBreakerOpenError` | Circuit đang OPEN | 503 Service Unavailable | Retry sau {resetTimeout}ms |
| `TimeoutError` | Request timeout (> 3s) | 504 Gateway Timeout | Retry với exponential backoff |
| `NetworkError` | Connection refused | 503 Service Unavailable | Retry sau delay |

### D.6. Monitoring Requirements

Circuit Breaker PHẢI expose các metrics sau:

```javascript
// Prometheus metrics
circuit_breaker_state{service="order", target="product"}  // 0=CLOSED, 1=OPEN, 2=HALF_OPEN
circuit_breaker_calls_total{service, target, status}      // status: success|failure|rejected
circuit_breaker_failure_count{service, target}            // Failure count hiện tại
circuit_breaker_open_duration_seconds{service, target}    // Tổng thời gian circuit ở trạng thái OPEN
```

### D.7. Testing Strategy

**Unit Tests:**
- Verify state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
- Test failure threshold triggering
- Test success threshold recovery
- Test timeout behavior

**Integration Tests:**
- Simulate downstream service failure (mock Product Service down)
- Verify Circuit OPEN after 5 failures
- Wait reset timeout, verify HALF_OPEN state
- Successful requests → verify Circuit CLOSED

**Load Tests:**
- Test behavior under high load với intermittent failures
- Verify không có memory leaks khi circuit open/close nhiều lần
- Benchmark overhead của Circuit Breaker (<5ms per call)

### D.8. Implementation Checklist

- [ ] Create `packages/circuit-breaker/` với package.json
- [ ] Implement CircuitBreaker class với state machine
- [ ] Add Prometheus metrics integration
- [ ] Write unit tests (>90% coverage)
- [ ] Update `services/order/` để sử dụng Circuit Breaker cho Product Service calls
- [ ] Add Grafana dashboard panel cho Circuit Breaker states
- [ ] Configure alerts cho `CircuitBreakerOpen` condition
- [ ] Document API usage trong README.md

-----

## 10\. Ngoài phạm vi (Future Scope)

Các hạng mục sau được xác định là KHÔNG thuộc phạm vi của phiên bản này, nhưng có thể được xem xét trong tương lai:

  * [ ] Mã hóa dữ liệu nhạy cảm (PII) của người dùng trong database (AES-256).
  * [ ] Bảo mật giao tiếp giữa các service nội bộ (mTLS với mutual certificates).
  * [ ] Triển khai Saga Timeout (tự động hủy order nếu không xử lý xong trong 30s).
  * [ ] Triển khai CQRS pattern với separate read/write models.
  * [ ] Data encryption at rest cho sensitive fields (passwords, payment info).
  * [ ] Advanced RBAC với fine-grained permissions (USER, MERCHANT, ADMIN roles).
  * [ ] GDPR compliance features (data export, right to deletion).
  * [ ] Multi-tenancy support cho B2B scenarios.
  * [ ] Circuit Breaker cho các external API calls (Payment Gateway, Email/SMS providers).
  * [ ] Bulkhead Pattern để isolate thread pools cho các downstream services khác nhau.