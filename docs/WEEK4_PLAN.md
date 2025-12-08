### 📅 TUẦN 4: Safety Net (Resilience & Reliability)

**Mục tiêu:** Đảm bảo hệ thống có khả năng tự phục hồi, xử lý lỗi (Retry/DLQ) và code sạch sẽ trước khi scale.

| Tên Task | Mô tả chi tiết |
| :--- | :--- |
| **1. Refactor Inventory Service** | **(Mới bổ sung)** Áp dụng các thay đổi đã thảo luận:<br> 1. Tách `InventoryAuditService` để gom logic ghi log.<br> 2. Viết helper `executeWithLock` để loại bỏ code lặp distributed lock.<br> 3. Đảm bảo Transaction cho hàm `reserveStockBatch`. |
| **2. Cấu hình & Test DLQ** | 1. Cập nhật `packages/message-broker`: Tự động khai báo `x-dead-letter-exchange` trỏ về `events.dlq` cho mọi queue.<br> 2. Phân loại lỗi trong Consumer: <br>   - **Lỗi Schema (Joi validate fail):** Gọi `nack(msg, false, false)` -> Vào DLQ ngay.<br>   - **Lỗi DB/Network:** Gọi `nack(msg, false, true)` (Requeue) hoặc dùng Retry Plugin (sẽ làm kỹ ở phase sau). |
| **3. Idempotency Implementation** | 1. **Inventory:** Đảm bảo `InventoryService` kiểm tra `processed_events` (hoặc Redis key) trước khi xử lý `order.created` để tránh trừ kho 2 lần.<br> 2. **Test:** Gửi *cùng* một message `order.created` (đúng schema) 2 lần liên tiếp. Mong đợi: Kho chỉ trừ 1 lần, log báo "Duplicate event ignored". |
| **4. Test Edge Case (Manual)** | 1. **Poison Message:** Gửi JSON thiếu field `productId` lên queue. Check xem service KHÔNG crash và message nằm gọn trong `events.dlq`.<br> 2. **Concurrency:** Dùng k6 bắn 10 request mua cùng 1 sản phẩm (số lượng tồn kho = 1). Mong đợi: Chỉ 1 đơn thành công, 9 đơn thất bại (nhờ Locking). |
| **5. Documentation** | Cập nhật `README.md`: <br> 1. Vẽ sơ đồ Saga (Choreography) bằng Mermaid.<br> 2. Thêm mục "Troubleshooting": Hướng dẫn dùng RabbitMQ Shovel để replay message từ DLQ. |

**✅ Tiêu chí hoàn thành (AC):**

  * Code Inventory Service gọn gàng, tách biệt logic Audit/Lock.
  * Một message lỗi schema sẽ tự động chui vào `events.dlq` mà không làm crash service.
  * Gửi trùng message không gây sai lệch dữ liệu (Idempotency hoạt động).
  * `README.md` có sơ đồ kiến trúc mới nhất.