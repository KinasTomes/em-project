# GIAI ĐOẠN 1: Xây dựng MVP Saga đáng tin cậy (4 Tuần)

**Mục tiêu:** Hoàn thành luồng Saga 6-service (Order → Inventory → Payment → Notification) với logic compensation (hoàn tác) và **đảm bảo tính toàn vẹn dữ liệu tuyệt đối**.

-----

### 📅 TUẦN 1: Nền tảng Monorepo & Broker Thông minh (Đã cập nhật OTel)

**Mục tiêu:** Thiết lập nền tảng `pnpm` monorepo, xây dựng package `@ecommerce/broker` (với Idempotency & Schema Validation) và **tích hợp OpenTelemetry (OTel) làm nguồn `correlationId` (traceId) thống nhất**.

| Tên Task | Mô tả chi tiết |
| :--- | :--- |
| **Setup Monorepo** | (Không thay đổi) Dùng `pnpm init -w` ở gốc. Tạo `packages/` và `services/`. Cài đặt ESLint + Prettier. |
| **Di chuyển Service** | (Không thay đổi) Di chuyển 4 service cũ (`auth`, `order`, `product`, `api-gateway`) vào `services/`. |
| **Tạo Gói Chung (Shared Packages)** | 1. `@ecommerce/logger`: (Dùng `pino`) Logger JSON chuẩn. **Nâng cấp: Phải tự động tích hợp (inject) `traceId` và `spanId` từ OTel context (span) đang hoạt động vào *mọi* dòng log.**<br> 2. `@ecommerce/config`: (Dùng `zod`) Để validate `.env` ngay khi khởi động.<br> 3. `@ecommerce/broker`: (Chi tiết bên dưới).<br> 4. `@ecommerce/tracing`: (Dùng `@opentelemetry/sdk-node`) **Gói này sẽ cấu hình NodeSDK, exporter (trỏ đến Jaeger), và các "auto-instrumentation" cơ bản (như HTTP, Express).** |
| **Xây dựng `Broker` Thông minh (Nâng cấp)** | Hoàn thiện `packages/message-broker` (`@ecommerce/broker`):<br> 1. **Publish:** Hàm `publish(queue, data, { eventId })`.<br>     a. **Tự động lấy `traceId` (đóng vai trò `correlationId`) và OTel Context** từ span OTel đang hoạt động.<br>     b. **Tự động inject OTel Context (header `traceparent`) vào message properties headers** để lan truyền trace.<br>     c. Đảm bảo `eventId` (uuid) luôn được truyền đi.<br>     d. Thêm retry (3 lần) nếu connection lost trước khi throw.<br> 2. **Consume (Nâng cấp):** Hàm `consume(queue, handler, schema)` sẽ "bọc" `handler` lại với **4 lớp bảo vệ**:<br>     a. **Lớp 0 (Tracing):** **Trích xuất (extract) OTel context từ `msg.properties.headers`**. Tạo một span "con" mới (`tracer.startActiveSpan`) bao bọc toàn bộ quá trình xử lý.<br>     b. **Lớp 1 (Idempotency):** Check `eventId` trong Redis.<br>     c. **Lớp 2 (Schema Validation):** Dùng `zod` và `schema`. Nếu fail → Ghi log lỗi → `nack(msg, false, false)` để **đẩy vào DLQ**.<br>     d. **Lớp 3 (Handler):** Lấy `traceId` từ span OTel đang hoạt động. `await handler(parsedData, { correlationId: traceId })`. |
| **Cài đặt OTel Tracing Middleware** | **(Thay thế task "Middleware correlationId" cũ)**<br> 1. Sử dụng `@ecommerce/tracing` để **khởi tạo OTel SDK** ngay khi `api-gateway` và các service khác khởi động.<br> 2. Thêm OTel middleware (ví dụ: từ `instrumentation-express`) vào `api-gateway` để **tự động tạo root span và `traceId`** cho mỗi request đến.<br> 3. Các service khác cũng dùng middleware này để **tự động đọc header `traceparent`** từ request và tiếp tục trace.<br> 4. Đảm bảo `@ecommerce/logger` được tích hợp để tự động đọc context từ OTel. |
| **Cập nhật Docker** | (Không thay đổi) Cập nhật `docker-compose.yml` và `Dockerfile`. Thêm **Redis** (cho idempotency) và **Jaeger** (cho tracing). |
| **Đồng bộ Clean Architecture** | (Không thay đổi) Sử dụng `auth` làm mẫu để refactor các service khác. |

**✅ Tiêu chí hoàn thành (AC):**

  * `pnpm install` và `docker-compose up` (bao gồm cả Redis, Jaeger) chạy thành công.
  * Hàm `consume` của broker **tự động bỏ qua** message trùng `eventId`.
  * Hàm `consume` **tự động ném vào DLQ** nếu message có schema (payload) không hợp lệ.
  * Log của các service (cả HTTP và consumer) phải **tự động chứa `traceId` (đóng vai trò là `correlationId`)** mà không cần truyền tay.
  * Test unit cho broker: Mock Zod fail → DLQ; Mock duplicate eventId → skip. Code coverage \>80%.
  * **(Mới)** Một request `POST /orders` phải tạo ra một trace hoàn chỉnh trên **Jaeger UI**, cho thấy span từ `api-gateway` và span `publish` từ `order-service` (nếu đã làm Tuần 2).

-----

### 📅 TUẦN 2: Trái tim Saga (Transactional Outbox với Change Streams)

**Mục tiêu:** Triển khai luồng Saga đầu tiên (Order → Inventory) và áp dụng **Transactional Outbox Pattern** bằng **MongoDB Change Streams**.

| Tên Task | Mô tả chi tiết |
| :--- | :--- |
| **Tạo `Inventory Service`** | Tạo service mới `services/inventory` (dùng cấu trúc `src/` chuẩn). Thêm vào `docker-compose.yml`. |
| **Tạo Model (Inventory & Outbox)** | 1. **Inventory Service:** Model Mongoose: `{ productId: String, stock: Number }`. <br> 2. **Order Service:** Model Mongoose: `{ payload: Object, status: 'PENDING', eventId: String, correlationId: String, timestamp: Date (UTC) }` tên là `outbox`. |
| **Sửa `Order Service` (Producer) - Transactional Outbox** | **Rất quan trọng!** Sửa logic `POST /orders` (controller/use-case): <br> 1. Bắt đầu 1 Mongo Transaction (`session.startTransaction()`).<br> 2. `const order = await orderService.create(req.body, { session });` (Tạo đơn hàng với status `PENDING`).<br> 3. Tạo 1 document event (chứa `ORDER_CREATED` payload, `correlationId`, `eventId`) và **chèn nó vào collection `outbox`** (cũng dùng `{ session }`).<br> 4. `await session.commitTransaction();`<br> 5. **KHÔNG** gọi `broker.publish()`.<br> 6. `res.status(201).json(order);` |
| **Tạo `Outbox Processor` (Mongo Change Stream)** | **(Nâng cấp CDC):** Trong `Order Service`, tạo 1 module riêng (ví dụ: `OutboxProcessor`).<br> 1. Sử dụng `Order.watch()` (hoặc `db.collection('outbox').watch()`) để "lắng nghe" các sự kiện `insert` trên collection `outbox`.<br> 2. Khi có document mới (`fullDocument`): <br>     a. Lấy `payload`, `correlationId`, `eventId` từ `fullDocument`.<br>     b. `await broker.publish('ORDER_CREATED', payload, { correlationId, eventId });`<br>     c. Update document `outbox` đó: `status: 'PROCESSED'`. <br> 3. Thêm handling errors: Reconnect nếu stream close, dùng `resumeAfter` token để resume từ last event khi restart. Thêm retry với exponential backoff (dùng `async-retry`, 1-5-10s) nếu publish fail; giữ 'PENDING' và retry. |
| **Viết `Inventory Service` (Consumer)** | Dùng `broker.consume('ORDER_CREATED', ...)`. <br> **Logic handler:** (Không cần lo chống lặp hay schema, broker đã lo)<br> 1. Nhận message, log với `correlationId`.<br> 2. Kiểm tra tồn kho (logic `reserveStock()`, dùng transaction của Mongo). Thêm idempotency check bổ sung cho critical ops.<br> 3. Nếu OK: Giảm `stock`, publish sự kiện `STOCK_RESERVED`.<br> 4. Nếu Hết hàng: Publish sự kiện `STOCK_REJECTED`. |
| **Sửa `Order Service` (Consumer)** | Dùng `broker.consume('STOCK_REJECTED', ...)` → Cập nhật status `Order` thành `CANCELLED`. |

**✅ Tiêu chí hoàn thành (AC):**

  * `POST /orders` → `Order` được tạo (PENDING), `outbox` document được tạo.
  * Log của `Outbox Processor` (Change Stream) nhận được event và `broker.publish` thành công.
  * Log `Inventory Service` nhận được event và trừ kho.
  * **Test lỗi:** Tắt RabbitMQ, `POST /orders`. Thấy `Order` được tạo, `outbox` document được tạo. Bật RabbitMQ. `Outbox Processor` sẽ retry (hoặc fail), nhưng event vẫn nằm trong `outbox` (bạn cần thêm logic retry cho processor này).
  * Test offline: Tắt RabbitMQ, POST order → outbox persist. Bật lại → processor auto-publish sau retry.

-----

### 📅 TUẦN 3: Hoàn thành Luồng & Logic Hoàn tác (Compensation)

**Mục tiêu:** Thêm 2 service nữa (`Payment` & `Notification`) và triển khai logic "hoàn tác" (Compensation) đầy đủ.

| Tên Task | Mô tả chi tiết |
| :--- | :--- |
| **Tạo `Payment Service`** | Tạo `services/payment` (không cần DB). Thêm vào Docker Compose. |
| **Viết `Payment Service` (Consumer)**| Dùng `broker.consume('STOCK_RESERVED', ...)`. <br> Logic handler: <br> 1. **Mock thanh toán:** Dùng `Math.random()` để quyết định thành công (> 0.1) hay thất bại (< 0.1). <br> 2. Publish `PAYMENT_SUCCEEDED` hoặc `PAYMENT_FAILED`. |
| **Sửa `Order Service` (Consumer)** | 1. Dùng `broker.consume('PAYMENT_SUCCEEDED', ...)` → Cập nhật status `Order` thành `CONFIRMED`.<br> 2. Dùng `broker.consume('PAYMENT_FAILED', ...)` → Cập nhật status `Order` thành `CANCELLED`. Sử dụng state machine (finite-state-machine lib) trong Order model để manage statuses. |
| **Logic Hoàn tác (Compensation)** | **Rất quan trọng!** <br> `Inventory Service` phải consume `PAYMENT_FAILED`. <br> Logic handler: Tìm lại hàng đã trừ (dựa trên `orderId`), **cộng ngược trở lại** (release stock). Logic này cũng phải được bọc trong `consume` để đảm bảo idempotent (tránh cộng kho 2 lần). Mở rộng để handle partial failures (ví dụ: nếu Payment succeed nhưng business validation fail, publish COMPENSATE_PAYMENT để rollback toàn chain). |

**✅ Tiêu chí hoàn thành (AC):**

  * Chạy luồng "Happy Path": `Order` → `Inventory` → `Payment` → `Order` (Status: `CONFIRMED`).
  * Chạy luồng "Unhappy Path" (Compensation): Cố tình làm `Payment` fail.
  * Kiểm tra log `Inventory Service` phải báo "Đã hoàn lại kho".
  * Kiểm tra `Order` DB status phải là `CANCELLED`.
  * Test duplicate compensation: Publish PAYMENT_FAILED 2 lần → stock chỉ release 1 lần (idempotent).

-----

### 📅 TUẦN 4: Safety Net (DLQ & Basic Tests)

**Mục tiêu:** Đảm bảo hệ thống có thể xử lý "poison message" và thêm các test cases.

| Tên Task | Mô tả chi tiết |
| :--- | :--- |
| **Cấu hình & Test DLQ** | 1. Cập nhật `packages/message-broker` để khi khai báo queue, nó tự động khai báo `deadLetterExchange` trỏ đến 1 queue chung là `events.dlq`.<br> 2. Đảm bảo logic `nack(msg, false, false)` trong `consume` (khi schema fail) hoạt động. Thêm auto-alert cho DLQ non-empty (tích hợp với Grafana ở Tuần 5). |
| **Test Edge Case (Manual)** | 1. **Test DLQ:** Gửi một message với payload sai (thiếu trường) lên queue `ORDER_CREATED`. Kiểm tra xem service `Inventory` *không* bị crash, và message đó xuất hiện trong `events.dlq`.<br> 2. **Test Idempotency:** Gửi *cùng* một message (đúng schema) 2 lần. Kiểm tra log `Inventory` chỉ xử lý 1 lần.<br> 3. Test network partition: Dùng Docker network delay để simulate latency. |
| **Xử lý DLQ** | Tạo script CLI (thủ công) để consume DLQ, review/replay messages sau khi fix schema. |
| **Cập nhật `README.md`** | Cập nhật `GEMINI.md`: Thêm 3 service mới, và **vẽ sơ đồ Saga** bằng Mermaid.js. Thêm phần "Debugging Guide" với cách inspect DLQ và replay events. Thêm "Scaling Notes": "Sử dụng Kubernetes cho horizontal scaling services; Change Streams cần resumeToken để multiple instances không duplicate processing." |

**✅ Tiêu chí hoàn thành (AC):**

  * Một message lỗi (poison message) sẽ tự động bị ném vào DLQ và *không* làm crash service.
  * Toàn bộ luồng (Order, Inventory, Payment) hoạt động với `correlationId` xuyên suốt.
  * File `README.md` được cập nhật, có sơ đồ kiến trúc Saga.
  * README có phần 'Debugging Guide' với cách inspect DLQ và replay events.

-----

## GIAI ĐOẠN 2: Production Hardening & Tối ưu (2 Tuần)

**Mục tiêu:** Làm cho Saga "cứng" hơn, có thể đo lường (observable) và tối ưu hiệu suất (performant).

### 📅 TUẦN 5: Đo lường & Quan sát (Monitoring)

**Mục tiêu:** Cài đặt Prometheus/Grafana và thêm các custom metrics để "nhìn thấy" được bên trong Saga.

| Tên Task | Mô tả chi tiết |
| :--- | :--- |
| **Setup Monitoring Stack** | Thêm Prometheus + Grafana + `rabbitmq_exporter` vào `docker-compose.yml`. Tích hợp OpenTelemetry exporter cho traces. |
| **Thêm Custom Metrics (Nâng cấp)** | Dùng `prom-client` trong các service:<br> 1. **Counters:** `saga_started_total`, `saga_completed_total`, `saga_failed_total`.<br> 2. **Histogram (Per-Step Latency):** `saga_step_latency_seconds{step="order_to_inventory"}`. (Đo thời gian từ khi `publish` đến khi `consume` và `ack`).<br> 3. **Metric `queue_depth`:** (Lấy từ RabbitMQ Exporter).<br> 4. **Gauge:** `outbox_pending_count` (query Mongo periodic để expose metric). |
| **Xây dựng Grafana Dashboard** | Tạo dashboard hiển thị: <br> 1. Saga throughput (started/min).<br> 2. Tỷ lệ lỗi Saga (failed / started).<br> 3. Phân vị (P95, P99) của `saga_step_latency` (để tìm bottleneck).<br> 4. **Quan trọng:** Độ sâu của tất cả các hàng đợi (Queue Depth).<br> 5. Panel cho end-to-end Saga latency (từ API call đến final status). |
| **Cấu hình Alerts** | Cài đặt Alertmanager (hoặc Grafana Alerting):<br> 1. **Alert 1:** `rabbitmq_queue_messages_ready > 100` (bất kỳ queue nào, trừ DLQ) → Báo động Bottleneck.<br> 2. **Alert 2:** `queue_depth(events.dlq) > 0` → Báo động có Poison Message.<br> 3. **Alert 3:** `saga_failed_total > 5% of started` → notify dev.<br> 4. Alert nếu outbox document >1 giờ chưa processed. |

**✅ Tiêu chí hoàn thành (AC):**

  * Bạn có thể thấy một spike (tăng vọt) trên dashboard `saga_step_latency` khi bạn cố tình thêm `setTimeout(5000)` vào 1 consumer.
  * Bạn nhận được alert khi cố tình đẩy message vào DLQ.
  * Dashboard trace một Saga full chain, hiển thị latency per step <1s (P99).

-----

### 📅 TUẦN 6: Tối ưu (Load Test & Advanced Retry)

**Mục tiêu:** Kiểm tra tải và xử lý các lỗi tạm thời (transient errors) một cách thông minh.

| Tên Task | Mô tả chi tiết |
| :--- | :--- |
| **Thêm "Godkey" cho Test** | **(Nâng cấp Security):** Thêm logic vào `api-gateway`: Nếu request header có `X-API-KEY` (lấy từ env var) thì bypass (bỏ qua) check JWT. **Chỉ bật ở môi trường test/dev.** Thêm rate limiting với Redis cho Godkey. |
| **Viết k6 Load Test (E2E)** | **(Nâng cấp Test):** Viết 1 kịch bản `k6`:<br> 1. Dùng "Godkey" để xác thực.<br> 2. `POST /api/v1/orders`. Lấy `orderId` từ response.<br> 3. Bắt đầu 1 `Trend` metric (ví dụ `saga_e2e_latency`).<br> 4. **Polling:** `GET /api/v1/orders/:id` (cần thêm endpoint này) trong vòng lặp (10 lần, cách 1s) cho đến khi status là `CONFIRMED` hoặc `CANCELLED`.<br> 5. Dừng `Trend` metric.<br> 6. Chạy test `k6 run --vus 50 --duration 1m` và theo dõi Dashboard Tuần 5.<br> 7. Thêm scenario cho unhappy path (inject failures qua env var để trigger PAYMENT_FAILED). |
| **Nâng cấp `Broker` (Advanced Retry)** | **(Nâng cấp Retry):** Cập nhật logic `consume` trong `@ecommerce/broker`:<br> 1. Định nghĩa 1 `TransientError` (lỗi tạm thời, ví dụ: DB_LOCKED, NETWORK_TIMEOUT).<br> 2. Trong `try...catch` của `handler`:<br>     `catch (error)`:<br>         `if (error instanceof TransientError)`:<br>             // Thực hiện retry (sử dụng RabbitMQ delayed exchanges cho backoff nếu version hỗ trợ, hoặc `nack(msg, false, true)` để requeue với exponential backoff).<br>         `else`: <br>             // Lỗi vĩnh viễn (Poison Message)<br>             `nack(msg, false, false)` → Đẩy vào DLQ. |
| **Test Compensation (k6)** | Viết 1 kịch bản k6 thứ 2, cố tình trigger `PAYMENT_FAILED` và đo thời gian E2E của luồng compensation. |
| **CI/CD Basic** | Thêm GitHub Actions để run unit tests và k6 trên PR. |

**✅ Tiêu chí hoàn thành (AC):**

  * Bạn có thể chạy `k6 run ...` và xem kết quả P95 `saga_e2e_latency` (ví dụ: "2.8s").
  * Khi chạy load test, dashboard Grafana hiển thị Queue Depth ổn định (không tăng vô hạn).
  * Khi bạn giả lập một `TransientError`, message được retry (thấy trong log) thay vì bị ném vào DLQ.
  * Dưới load 50 VUs, queue depth <50, no backlog; Transient errors được retry thành công (log show 2-3 attempts).