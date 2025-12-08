# 📅 TUẦN 5: Hoàn thiện Monitoring & Alerting

**Mục tiêu:** Kết nối các metrics đã implement vào Prometheus/Grafana để xây dựng Dashboard trực quan và thiết lập hệ thống cảnh báo (Alerting) thực chiến.

> **Trạng thái:** 🔴 Chưa bắt đầu | 🟡 Đang thực hiện | ✅ Hoàn thành

---

## 1. Kế hoạch chi tiết

| Tên Task | Trạng thái | Mô tả chi tiết & Hành động |
| :--- | :--- | :--- |
| **1. Config Infrastructure** | 🔴 | **Cấu hình Prometheus (`prometheus.yml`):** <br> - Thêm scrape targets cho tất cả services: `api-gateway`, `auth`, `order`, `product`, `inventory`, `payment`. <br> - Config scrape interval: `15s`. <br> **Cấu hình RabbitMQ:** <br> - Enable plugin `rabbitmq_prometheus` để lấy metrics hàng đợi. |
| **2. Dashboard: Business KPI** | 🔴 | Tạo Dashboard **"E-commerce Business"** trên Grafana hiển thị: <br> - **Orders:** `sum(rate(order_created_total[5m]))` (Đơn hàng/phút). <br> - **Revenue:** `sum(rate(payment_amount_total[1h]))` (Doanh thu). <br> - **Inventory:** `inventory_stock_level` (Tồn kho hiện tại - Gauge). <br> - **Products:** `product_total_count` (Tổng sản phẩm). |
| **3. Dashboard: System Health** | 🔴 | Tạo Dashboard **"Tech Overview"** hiển thị sức khỏe 6 services: <br> - **Traffic:** `http_requests_total` (Request Rate). <br> - **Latency:** `http_request_duration_seconds` (P95, P99). <br> - **Errors:** Tỷ lệ HTTP 5xx. <br> - **Resources:** CPU (`process_cpu_seconds`) & RAM (`process_resident_memory`). <br> - **NodeJS:** Event Loop Lag (`nodejs_eventloop_lag_seconds`). |
| **4. Dashboard: Resilience** | 🔴 | Dashboard chuyên dụng cho độ tin cậy (Saga & Circuit Breaker): <br> - **Circuit Breaker:** Panel hiển thị `order_circuit_breaker_state` (0=Closed, 1=Open). <br> - **Saga Operations:** `order_saga_operations_total`. <br> - **Outbox:** `order_outbox_pending_messages`. <br> - **Rate Limit:** `gateway_rate_limit_hits_total`. |
| **5. Setup Alerting Rules** | 🔴 | Cấu hình **Prometheus AlertManager** với các rules đã định nghĩa: <br> - `HighErrorRate`: > 5% lỗi trong 5 phút. <br> - `HighLatency`: P95 > 2s. <br> - `CircuitBreakerOpen`: Báo động Critical ngay lập tức. <br> - `LowStock`: Khi `inventory_stock_level < 10`. <br> - `DLQ_NotEmpty`: Khi queue `events.dlq` có tin nhắn (> 0). |
| **6. Monitor RabbitMQ** | 🔴 | Dashboard theo dõi Message Broker: <br> - Queue Depth: `rabbitmq_queue_messages`. <br> - Unroutable Messages. <br> - Consumer Count. |

---

## 2. Tiêu chí hoàn thành (Acceptance Criteria)

### ✅ AC1: Visualization (Nhìn thấy được)
- [ ] Chạy k6 test (`order-integration.test.js`), Dashboard "System Health" phải hiển thị biểu đồ Request Rate và Latency tăng lên tương ứng.
- [ ] Dashboard "Business" phải hiển thị đúng số lượng đơn hàng vừa tạo trong bài test.

### ✅ AC2: Resilience Monitoring (Thấy lỗi)
- [ ] Khi tắt `inventory-service` (mô phỏng lỗi), Dashboard phải hiển thị:
    - `gateway_upstream_health{service="inventory"}` chuyển về 0.
    - Error Rate của Order Service tăng lên.
    - `order_circuit_breaker_state` chuyển sang 1 (Open) sau ngưỡng lỗi.

### ✅ AC3: Alerting (Báo động)
- [ ] Nhận được thông báo (qua Slack/Discord/Email giả lập) khi:
    - CPU usage > 80% (stress test).
    - Có tin nhắn rơi vào Dead Letter Queue (`events.dlq`).

---

## 3. Tài nguyên tham khảo

- **Metric Definitions:** Xem file `METRICS.md` để lấy tên metric chính xác.
- **PromQL Cheatsheet:**
    - Error Rate: `rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m])`
    - P95 Latency: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`