# 🛍️ Amazona — E-Commerce Website (Improved Version)

> **Bài tập lớn môn Kiến trúc phần mềm – I2526 (3105_2)**  
> **Đề tài:** Cải tiến hệ thống thương mại điện tử Amazona (bản gốc từ GitHub)

---

## 👥 Nhóm 4
- **Vũ Quốc Tuấn**
- **Nguyễn Đức Toàn**
- **Nguyễn Thanh Tùng**
- **Nguyễn Việt Thắng**

---

## 📌 Bản gốc
- GitHub Repository: https://github.com/basir/mern-amazona?fbclid=IwY2xjawOaM1tleHRuA2FlbQIxMQBzcnRjBmFwcF9pZAEwAAEecU4CBGvNOEQ3xPuH_hBekjxDGuIqvA4m6aGRkQ1igLswy1DsHccVjAavyaM_aem_bl_ooJN9H39X7Cp2Z1bzyg
- Demo Website: https://amazona.onrender.com  

---

## 🧩 Chức năng chính của bản gốc

Hệ thống Amazona gốc bao gồm:
- Quản lý **sản phẩm**, **đơn hàng**, **người dùng**, **dashboard**
- **Đặt hàng**, **thanh toán online** qua PayPal / Stripe
- **Phân loại sản phẩm**, **lọc sản phẩm**
- Tích hợp **Google Map API**

---

# 🚀 Các cải tiến & tính năng mới

## **1. Vũ Quốc Tuấn**

---

# 🟦 A. Health Check  

### **/healthz – Liveness Probe**
- Kiểm tra service còn sống  
- Trả về **503** khi graceful shutdown  
- Được Docker HEALTHCHECK gọi để restart container nếu fail  

### **/readyz – Readiness Probe**
- **MongoDB ping** (timeout 800ms)  
- **Redis ping** (timeout 500ms)  
- **Latency p95** của 50 request gần nhất  
- **SLA enforcement:** cảnh báo khi latency > 700ms  
- **Degradation:** trả 503 nếu > 2× SLA trong 3 lần liên tiếp  

### **Multi-layer validation**
- Docker HEALTHCHECK  
- Compose dependency (Mongo/Redis healthy mới chạy backend)  
- Traefik /readyz mỗi 5s  
- Graceful shutdown: stop accepting requests, chờ job done, trả 503 trong quá trình shutdown  

📌 
<img width="247" height="159" alt="image" src="https://github.com/user-attachments/assets/d125b78f-e10d-42fc-ad3b-f0931b8ef45d" />
<img width="554" height="117" alt="image" src="https://github.com/user-attachments/assets/2fffac32-a3c3-4cfa-acc8-bd0689f3e19d" />


---

# 🟩 B. Traefik Load Balancer / Reverse Proxy

- Dynamic service discovery qua Docker labels  
- Health-based routing: container không ready → bị remove khỏi pool  
- Horizontal scaling:  
  ```bash
  docker compose up -d --scale backend=3
- Traefik tự động phân phối traffic
- Container mới chỉ nhận traffic khi đã ready, tránh lỗi request vào lúc deploy

📌 Trước khi scale 
<img width="894" height="132" alt="image" src="https://github.com/user-attachments/assets/89ea2a32-b3e7-470c-baef-bfeaa3665c76" />
<img width="1029" height="254" alt="image" src="https://github.com/user-attachments/assets/4aa55803-8e2c-4741-b5bf-f48c344a02c6" />
Sau khi Scale 2

<img width="887" height="100" alt="image" src="https://github.com/user-attachments/assets/a1d2ea84-b850-4fb8-b72c-8f2ffcd7b915" />
<img width="876" height="288" alt="image" src="https://github.com/user-attachments/assets/b6b8c7c5-733a-40ff-9715-960f96c2af5f" />


# 🟩 C. API Rate Limit (Traefik Layer)

Rate limiting được xử lý trực tiếp tại reverse proxy (Traefik), trước khi request đi vào backend.

### **Cấu hình Rate Limit**
- **Average limit:** 100 requests/second  
- **Burst:** 50 requests  
- **Scope:** theo IP address  

### **Mục tiêu**
- Ngăn chặn traffic spike đột biến  
- Bảo vệ backend khỏi brute-force & DDoS nhẹ  
- Đảm bảo API ổn định dưới tải lớn  

**Kết quả:** Request vượt ngưỡng → trả về **HTTP 429 – Too Many Requests**

📌 
<img width="1128" height="264" alt="image" src="https://github.com/user-attachments/assets/d7bb1377-e39f-4485-b824-adc7dd35341d" />
<img width="967" height="143" alt="image" src="https://github.com/user-attachments/assets/75b3834b-bbd2-4b53-bec6-360d6305d824" />

---

# 🟥 D. Multiple Queue – Redis BullMQ

### **Kiến trúc tổng quan**
- Sử dụng Redis Queue (BullMQ) để xử lý các tác vụ nặng **bất đồng bộ**
- Mô hình tách biệt:
  - **Backend API** → *producer*
  - **Worker Service** → *consumer*
- Hai container chạy độc lập → dễ scale

### **Order Processing Pipeline**
1. **update-inventory**  
   - Trừ số lượng sản phẩm trong kho  
2. **send-order-receipt-email**  
   - Gửi email xác nhận đơn hàng  
3. **notify-admin**  
   - Gửi thông báo đến admin  

### **Retry Mechanism (Exponential Backoff)**
- **update-inventory:** 5 lần retry, delay 3s (exponential)  
- **send-email:** 3 lần retry, delay 5s (exponential)  
- **notify-admin:** 3 lần retry, delay 5s (fixed)  

### **Worker Configuration**
- **Concurrency:** 5 (xử lý 5 job đồng thời)  
- **Job cleanup:**  
  - Xóa job success để tiết kiệm Redis  
  - Giữ lại 50 job failed gần nhất để debug  

### **Fallback Mechanism**
- Nếu queue gặp lỗi → rollback trạng thái thanh toán  
- Chuyển sang xử lý đồng bộ để đảm bảo không mất đơn hàng  

### **Lợi ích mang lại**
- API response **nhanh hơn** (không cần chờ email/inventory update)  
- Tăng **độ tin cậy** nhờ retry tự động  
- Scale worker **độc lập** với API server  
- Tránh block request khi gửi email chậm hoặc queue overloaded  

📌 <img width="1398" height="616" alt="image" src="https://github.com/user-attachments/assets/14e0af6c-1e0a-4400-ba18-d29a5fda10b3" />


---

# 🟪 E. Structured Logging – Pino

### **Lý do thay thế console.log**
- `console.log` blocking I/O → làm chậm event loop  
- Không có cấu trúc → khó tìm lỗi trong production  
- Không phù hợp khi tích hợp vào ELK / Cloud Logging

### **Pino Logging**
- Log JSON structured → dễ parse  
- Nhanh hơn console.log
- Hỗ trợ log levels: `info`, `warn`, `error`, `debug`

### **Các sự kiện được log**
- Server startup & shutdown  
- MongoDB connect/disconnect/reconnect  
- Redis connection errors  
- Cloudinary upload/delete  
- BullMQ: job start, complete, failed  
- User actions quan trọng (reset password, checkout)

📌 <img width="1427" height="746" alt="image" src="https://github.com/user-attachments/assets/6d28ebb4-b189-4791-8fa2-ea9712feef32" />


---

# 🟫 F. Mongoose Query Optimization – `.lean()`

### **Tối ưu read-heavy endpoints**
Áp dụng `.lean()` cho toàn bộ các **GET** endpoints:
- GET `/api/products`
- GET `/api/products/:id`
- GET `/api/products/slug/:slug`
- GET `/api/products/search`
- GET `/api/products/categories`

### **Vì sao .lean() cải thiện hiệu năng?**
- Không tạo Mongoose document → OBJECT nhẹ hơn  
- Không có getters/setters  
- Không có change tracking  
- Giảm **50–70%** memory footprint  
- Tăng **30–50%** tốc độ query và serialize JSON

### **Không dùng .lean() cho write/update**
- POST review  
- PUT update  
- DELETE  
- Order inventory update  

📌
<img width="1399" height="378" alt="image" src="https://github.com/user-attachments/assets/92f435bb-7fe6-4f3c-b106-fa96fa8a3f77" />

<img width="1085" height="557" alt="image" src="https://github.com/user-attachments/assets/237dcafa-7724-4b1e-8e92-f5e425cb051d" />


---

# 🟫 G. HTTP Compression – gzip

### **Cấu hình Compression**
- Sử dụng middleware `compression`  
- Nén các response JSON/HTML/CSS/JS  
- Tự động bỏ qua file đã nén (image, video)  

### **Lợi ích**
- Giảm **60–80%** kích thước payload  
- Load nhanh hơn trên mobile/3G  
- Giảm băng thông cho server  
- Tăng điểm Lighthouse Performance

📌 <img width="1501" height="74" alt="image" src="https://github.com/user-attachments/assets/5239faee-c4be-465e-94eb-10de4e39871a" />


---

# 🟫 H. Security Hardening – Helmet

### **Hoạt động ở phần middleware**
- `Chống XSS (Cross-Site Scripting)`
- `Ngăn chặn clickjacking`
- `Giảm nguy cơ tấn công injection`

📌
<img width="1548" height="311" alt="image" src="https://github.com/user-attachments/assets/126e3b58-3241-4169-98af-89740ab7e5d3" />
<img width="1682" height="599" alt="image" src="https://github.com/user-attachments/assets/54b22bd8-2f3a-4a69-b345-33766e355e92" />


---

# 🟦 I. OAuth2 Gmail – Email Authentication

### **Triển khai OAuth2 cho Nodemailer**
- Loại bỏ App Password (thiếu bảo mật)
- Sử dụng OAuth2 Client ID + Client Secret
- Tự động refresh Access Token
- Có thể revoke quyền truy cập từ Google Cloud Console

### **Use Cases**
- Gửi email xác nhận đơn hàng sau khi thanh toán
- Email background trong BullMQ Worker
- Email template HTML tùy chỉnh (thông tin đơn hàng / user)

### **Lợi ích**
- Bảo mật cao hơn App Password
- Không cần lưu mật khẩu trong server
- Token tự động refresh, không bị gián đoạn khi expired
- Có thể dễ dàng revoke khi bị lộ

📌 <img width="641" height="276" alt="image" src="https://github.com/user-attachments/assets/b0e9de0f-356f-4328-b9b6-0a460edb7060" />
<img width="828" height="589" alt="image" src="https://github.com/user-attachments/assets/71bfcae1-f288-45c4-99f4-2719aa840783" />


---

# 🟩 J. Business Intelligence – Metabase Integration

### **Setup**
- Container Metabase chạy tại port **3001**
- Volume riêng để lưu dashboard & configs
- Kết nối trực tiếp MongoDB (production)
- Không cần SQL — Query Builder trực quan

### **Use Cases**
- Dashboard theo dõi doanh thu theo ngày/tháng
- Biểu đồ số lượng đơn hàng
- Phân tích hành vi khách hàng
- Export báo cáo CSV / PDF
- Lên lịch gửi báo cáo tự động qua email

📌 <img width="1904" height="1001" alt="image" src="https://github.com/user-attachments/assets/4a84f8c0-0f98-4d91-a5c6-8505dc495652" />


---

# 🟩 K. MongoDB Connection Pooling Optimization

### **Tối ưu kết nối MongoDB với Connection Pool**
- **maxPoolSize: 50** — Cho phép tối đa 50 kết nối đồng thời  
- **serverSelectionTimeoutMS: 5000** — Timeout 5 giây khi chọn server  
- **socketTimeoutMS: 45000** — Socket timeout 45 giây  

### **Event Listeners**
- Theo dõi sự kiện **disconnect / reconnect**
- Tự động **auto-reconnect** khi mất kết nối
- Log toàn bộ qua **Pino** để hỗ trợ troubleshooting nhanh hơn

---

## **2. Nguyễn Việt Thắng**

---

# 🟦 Redis Cache

- Tăng thời gian truy xuất dữ liệu
- Giảm tải cho Database

### **Phân trang Homepage và cache theo page number**
- Cũ:
  - Gọi /api/products lấy sản phẩm từ trong Database
  - Render hết tất cả sản phẩm ra màn hình
  - Người dùng phải đợi render hết sản phẩm ra màn hình mới thao tác tiếp được
  <img width="1547" height="303" alt="Screenshot 2025-12-01 at 15 08 40" src="https://github.com/user-attachments/assets/a7519257-81d3-43dc-bcd1-7b47df0b82b8" />
  <img width="1585" height="265" alt="Screenshot 2025-12-01 at 15 09 11" src="https://github.com/user-attachments/assets/580c7695-5fda-4f7a-8eed-1d9f6a958973" />

- Mới:
  - Phân trang sao cho mỗi trang chỉ gồm 20 sản phẩm (render ra màn hình nhanh hơn)
  - Cache theo page number (với key là products:page:${pageNumber}) để không cần truy cập Database mỗi lần chuyển trang
  <img width="1536" height="263" alt="Screenshot 2025-12-01 at 15 09 30" src="https://github.com/user-attachments/assets/2914de59-0696-4298-8d1c-f6e06f7490df" />
  <img width="1579" height="285" alt="Screenshot 2025-12-01 at 15 09 38" src="https://github.com/user-attachments/assets/7381c4d5-c0af-45bb-a2e8-3b337fd98c99" />

### **Cache những sản phẩm được User xem gần đây, và những sản phẩm được admin chỉnh sửa**
- Những sản phẩm được User ấn vào xem sẽ có khả năng được User xem lại
- Ví dụ: Khi ấn vào một sản phẩm và chuyển sang xem sản phẩm khác, khi quay lại trang trước sẽ phải gọi Database để lấy sản phẩm của trang trước vừa xem
- Tương tự khi admin chỉnh sửa sản phẩm có thể thoát ra vào lại nhiều lần
- Cache theo slug của sản phẩm với (với key là products:slug:{productSlug})

- Trước:
<img width="1542" height="267" alt="Screenshot 2025-12-01 at 15 06 19" src="https://github.com/user-attachments/assets/41a6e97c-f70b-49b4-bf18-f1c3fe9a914a" />
<img width="1563" height="271" alt="Screenshot 2025-12-01 at 15 06 31" src="https://github.com/user-attachments/assets/f2989aa9-c6ac-4b9f-952d-942b78017d5e" />
<img width="1592" height="269" alt="Screenshot 2025-12-01 at 15 06 42" src="https://github.com/user-attachments/assets/bd53c0bc-88b3-4844-ad92-0ef4e4adc22e" />

- Sau:
<img width="1579" height="279" alt="Screenshot 2025-12-01 at 15 04 11" src="https://github.com/user-attachments/assets/0ea37965-b847-4390-be72-1adae5af08f2" />
<img width="1540" height="259" alt="Screenshot 2025-12-01 at 15 05 29" src="https://github.com/user-attachments/assets/953a059c-e502-49b8-9d17-c9909372635a" />
<img width="1561" height="262" alt="Screenshot 2025-12-01 at 15 05 43" src="https://github.com/user-attachments/assets/8671eb37-c810-4a21-8fb2-e7a2bcab7c29" />

### **Cache Invalidation - Xóa những dữ liệu cũ trong Cache khi Database cập nhật**
Khi một sản phẩm được cập nhật, ví dụ đổi tên hoặc giá sản phẩm giảm, dữ liệu sẽ được thay đổi trong Database. Nếu ta truy xuất dữ liệu trong Cache mà dữ liệu đó chưa đồng bộ với Database, ta sẽ lấy được sản phẩm với dữ liệu cũ, từ đó người dùng có thể thấy giá cũ được hiển thị cho sản phẩm.

- Mỗi khi một sản phẩm được cập nhật, ta xóa những key liên quan đến sản phẩm đó trong.
- Ví dụ:
  - Xóa key theo slug của sản phẩm products:slug:{productSlug}.
  - Xóa key cache theo trang khi một sản phẩm bị xóa
<img width="390" height="235" alt="Screenshot 2025-12-01 at 15 11 38" src="https://github.com/user-attachments/assets/15d001fd-ee07-48cd-91ea-0a72362f65a8" />

### **Flash sale**
Trong thời gian flash sale, số lượng User truy cập vào trang flash sale để xem những sản phẩm sẽ tăng lên. Đồng thời sẽ có nhiều thao tác thanh toán và sửa dữ liệu sản phẩm trong Database (giảm số lượng sản phẩm).

Redis cache giúp ta không phải truy cập Database trong thời gian diễn ra flash sale. Sử dụng những phép toán nhân tử (atomic operation) cộng, trừ ngay trong redis; thay vì lấy dữ liệu trong redis, tính toán ở backend, và cuối cùng cập nhật vào Database.

- Admin tạo sự kiện flash sale và thêm các sản phẩm được giảm giá vào.
- Trang flash sale lưu những sản phẩm được giảm giá theo key "products:flash-sale:active", mỗi lần một người dùng vào thì sẽ lấy dữ liệu sản phẩm trong redis.
- Khi một sản phẩm được mua và trừ số lượng, thao tác trừ sẽ được thực hiện và cập nhật ngay trong redis thay vì ở server backend.
 
<img width="1305" height="852" alt="Screenshot 2025-12-01 at 15 58 11" src="https://github.com/user-attachments/assets/e8f38ccd-f982-48b1-aba6-1617aabce469" />
<img width="903" height="185" alt="Screenshot 2025-12-01 at 15 59 09" src="https://github.com/user-attachments/assets/ed1aeadb-c44c-4973-876c-8f9ad861534e" />

<img width="1307" height="847" alt="Screenshot 2025-12-01 at 15 59 51" src="https://github.com/user-attachments/assets/28642847-8e0d-4cd9-b8f4-0ffd1378297d" />
<img width="894" height="161" alt="Screenshot 2025-12-01 at 16 00 02" src="https://github.com/user-attachments/assets/58f6aa2a-e3de-436b-9f67-1d88c056e3d9" />

---


## **3. Nguyễn Thanh Tùng**
---
#🟦 JWT Refresh Token - JWT Access Token
- JWT được dùng để:
  - Authentication: Xác thực người dùng
  - Authorization: Phân quyền truy cập tài nguyên.
- JWT Access Token
  - Access Token là JWT có thời gian sống ngắn, dùng cho mọi request từ clident đến API.
  - FE gửi trong mọi request đến API qua header:
    Authorization: Bearer <accessToken>
  - Lưu trữ: In-memory hoặc localStorage
  - Vì thời gian sống ngắn nên rủi ro khi lộ token sẽ thấp hơn. (Tăng tính an toàn khi có XSS)
- JWT Refresh Token
  - Refresh Token có thời gian sống dài hơn (7–30 ngày). Dùng để xin Access Token mới khi access token hết hạn.
  - Lưu trữ: Cookie HttpOnly + Secure + SameSite. (Không bị XSS đọc, browser sẽ tự gửi trong đúng domain, an toàn hơn localStorage)
  - Luồng Refresh chuẩn:
    + User đăng nhập, backend trả accessToken, refreshToken, csrfToken
    + Khi access token hết hạn -> API trả 401 Unauthorized.
    + FE sẽ gọi POST /refresh-token
    + Backend verify -> trả token mới
    + FE lưu access token và retry request ban đầu.
    + Nếu refresh token hết hạn, báo lỗi và yêu cầu đăng nhập phiên mới.
      <img width="2055" height="1102" alt="image" src="https://github.com/user-attachments/assets/bad42258-7093-468b-adfd-6cac85999c53" />

      
#🟥 CSRF Token
  - Do refresh token nằm trong cookie và gửi tự động -> cần chống CSRF.
  - FE lưu trong memory hoặc localStorage.
  - Hacker từ domain khác không thể đọc được CSRF token.
  - Bắt buộc với POST/ PUT/ PATCH/ DELETE, không áp dụng cho GET.

#🟪 CAPTCHA
  - Xác thực người dùng. Nếu người dùng không tick chọn captcha thì không đăng nhập được.

#🟩 Chặn brute-force mật khẩu
  - Ngăn chặn 1 tài khoản thử đăng nhập quá nhiều lần trên cùng 1 máy. Ví dụ nếu đăng nhập quá 5 lần trong 15’ mà ko thành công thì hệ thống sẽ chặn lại.
  - Log thông báo: “BẠN ĐÃ ĐĂNG NHẬP QUÁ NHIỀU LẦN, VUI LÒNG THỬ LẠI SAU”.(mã lỗi 429).
    => Ngăn chặn brute force mật khẩu
    <img width="1125" height="955" alt="image" src="https://github.com/user-attachments/assets/281a4773-6466-480e-ae41-94cfc71d3811" />


#🟦 Cá nhân hóa giỏ hàng
  - Trước kia, giỏ hàng được dùng chung, lưu trong localStorage, không phân biệt người dùng nào sử dụng giỏ hàng nào.
  - Thực hiện cá nhân hóa giỏ hàng, giúp người dùng mỗi người có một giỏ hàng riêng biệt, được lưu vào trong database, có thể thêm bớt, thanh toán thành công mà không ảnh hưởng đến ai.


---

## **4. Nguyễn Đức Toàn**
### **Voucher**
- Chức năng cho phép người dùng áp dụng mã giảm giá để giảm giá sản phẩm hoặc phí vận chuyển trong quá trình thanh toán. Mã giảm giá này có thể là phần trăm (percent) hoặc số tiền cố định (amount), và có thể áp dụng cho toàn bộ giỏ hàng hoặc cho các sản phẩm cụ thể. Các voucher này có thể có điều kiện về số lượng, thời gian áp dụng và giá trị đơn hàng tối thiểu

### **Các loại Voucher**
- Voucher giảm giá cho sản phẩm và Voucher giảm phí vận chuyển
- Có thể là giảm theo phần trăm (percent) hoặc số tiền cố định (amount)

### **Điều kiện áp dụng Voucher**
- **Tính hợp lệ**: Voucher phải hoạt động (isActive), chưa hết hạn (expiresAt), kích hoạt sau thời gian bắt đầu (startAt), số lượng còn (remainning)
- **Không áp dụng đồng thời**: chỉ được dùng tối đa 1 voucher sản phẩm cùng với 1 voucher phí vận chuyển

### **Các hàm hữu ích**
- **getEligibleSubtotal(voucher)**: Hàm này tính toán tổng giá trị hợp lệ của các sản phẩm trong giỏ hàng để xác định xem voucher có thể áp dụng không (áp dụng cho toàn bộ hay danh mục sản phẩm)
- **isVoucherApplicable(voucher)**: Hàm này kiểm tra xem voucher có thể áp dụng vào giỏ hàng hiện tại không
- **potentialDiscount(voucher)**: Hàm này tính toán mức giảm giá tiềm năng mà voucher có thể mang lại.

### **Cách sử dụng**
- Người dùng có thể lưu voucher, bỏ áp dụng voucher, thay đổi voucher, xem số tiền được giảm khi áp dụng voucher
- Admin có thêm chức năng tạo voucher

---

## 🛠️ Công nghệ sử dụng

- **Frontend:** React, Redux, Tailwind CSS / CSS modules  
- **Backend:** Node.js
- **Database:** MongoDB  
- **Authentication:** JWT  
- **Payment:** PayPal  
- **Triển khai:** Render / Docker / Traefik  

---

## 📦 Cài đặt & chạy dự án

```bash
# Clone
git clone <repo-link>

# Cài đặt
cd amazona
npm install

# Chạy backend
npm start

# Chạy frontend
cd frontend
npm start
