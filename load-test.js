// load-test.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  // Giả lập 20 người dùng (VUs) liên tục "spam" trong 30 giây
  vus: 200,
  duration: '30s',
};

// Lấy token từ terminal thay vì hardcode
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5MGYzYTRkMzUwMzk3YmE0Y2MwZGU4OCIsImlhdCI6MTc2MjYwNTg0MX0.sDouSKD_7K-eMM6FG6Ktr7fjb1sCWTrvAks0HtAesmA';

const url = 'http://localhost:3003/products/api/products/buy';
const payload = JSON.stringify({
  ids: ['690f4395902812eec47d86a5'],
});
const params = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
  },
};

export default function () {
  const res = http.post(url, payload, params);
  check(res, {
    'status was 2xx': (r) => r.status >= 200 && r.status < 300,
  });
}