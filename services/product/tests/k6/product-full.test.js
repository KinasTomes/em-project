import http from "k6/http";
import { check, sleep, group, fail } from "k6";
import { Rate } from "k6/metrics";

// === Metrics (mỗi bước một Rate) ===
const create_ok = new Rate("create_ok");
const list_ok = new Rate("list_ok");
const get_ok = new Rate("get_ok");
const update_ok = new Rate("update_ok");
const delete_ok = new Rate("delete_ok");
const inventory_create_ok = new Rate("inventory_create_ok");
const inventory_delete_ok = new Rate("inventory_delete_ok");
const flow_ok = new Rate("flow_ok");

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 10 },
    { duration: "10s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.1"],

    // YÊU CẦU ĐÚNG STATUS 100%
    create_ok: ["rate==1.0"],
    list_ok: ["rate==1.0"],
    get_ok: ["rate==1.0"],
    update_ok: ["rate==1.0"],
    delete_ok: ["rate==1.0"],
    inventory_create_ok: ["rate==1.0"],
    inventory_delete_ok: ["rate==1.0"],
    flow_ok: ["rate==1.0"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3004";
const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";
const INVENTORY_URL = __ENV.INVENTORY_URL || "http://localhost:3005";
const PRODUCTS_URL = `${BASE_URL}/api/products`;
const FLOW_NAME = "product-full";

export function setup() {
  const loginPayload = JSON.stringify({
    username: "testuser",
    password: "testpass123",
  });
  const res = http.post(`${AUTH_URL}/login`, loginPayload, {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "auth_login" },
  });

  if (res.status !== 200) {
    // Cho test fail ngay nếu không đăng nhập được
    fail(`Auth failed, status=${res.status}, body=${res.body}`);
  }
  const data = JSON.parse(res.body);
  console.log("✓ Authentication successful");
  return { token: data.token };
}

// ... y nguyên phần import & options

export default function (data) {
  if (!data.token) fail("No token in setup result");

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
  };

  let productId = null;
  // ✅ Đặt available đúng kỳ vọng
  const available = 200;

  let stepCreateOK = false;
  let stepListOK = false;
  let stepInventoryCreateOK = false;
  let stepInventoryDeleteOK = false;
  let stepGetOK = false;
  let stepUpdateOK = false;
  let stepDeleteOK = false;

  group("1) CREATE PRODUCT (expect 201 + inventory sync create)", () => {
    const payload = JSON.stringify({
      name: `Laptop Lenovo Legion -${Date.now()}-${__VU}`,
      price: Math.floor(Math.random() * 1000) + 10,
      description: `Load test product from VU ${__VU}`,
      available, // ✅ truyền đúng vào request
    });

    const res = http.post(PRODUCTS_URL, payload, {
      headers,
      tags: { endpoint: "products_create" },
    });

    const ok = check(res, {
      "status == 201": (r) => r.status === 201,
      "duration < 1000ms": (r) => r.timings.duration < 1000,
    });
    create_ok.add(ok);
    if (!ok) fail(`Create must be 201 (got ${res.status})`);

    try {
      const body = JSON.parse(res.body);
      productId = body._id;
    } catch (_) {
      /* ignore */
    }

    stepCreateOK = ok;
  });

  sleep(0.2);

  group("2) LIST PRODUCTS (expect 200)", () => {
    const res = http.get(PRODUCTS_URL, {
      headers,
      tags: { endpoint: "products_list" },
    });

    const ok = check(res, {
      "status == 200": (r) => r.status === 200,
      "duration < 500ms": (r) => r.timings.duration < 500,
    });
    list_ok.add(ok);
    if (!ok) fail(`List must be 200 (got ${res.status})`);
    stepListOK = ok;
  });

  sleep(0.2);

  group("3) VERIFY INVENTORY CREATED SYNCHRONOUSLY", () => {
    if (!productId) fail("No productId created");
    const res = http.get(`${INVENTORY_URL}/api/inventory/${productId}`, {
      headers,
      tags: { endpoint: "inventory_get_by_product" },
    });
    const ok = check(res, {
      "inventory status == 200": (r) => r.status === 200,
    });
    let valueMatch = false;
    if (res.status === 200) {
      try {
        const inv = JSON.parse(res.body);
        valueMatch = Number(inv?.available) === Number(available);
      } catch (_) {}
    }
    const finalOk = ok && valueMatch;
    inventory_create_ok.add(finalOk);
    if (!finalOk) {
      console.error(
        `Inventory create sync failed: status=${res.status} body=${res.body} expectedAvailable=${available}`
      );
      fail("Inventory must exist with correct available after product create");
    }
    stepInventoryCreateOK = finalOk;
  });

  group("4~6) GET/UPDATE/DELETE product + verify inventory delete", () => {
    if (!productId) fail("No productId created");

    const getRes = http.get(`${PRODUCTS_URL}/${productId}`, {
      headers,
      tags: { endpoint: "products_get" },
    });
    const getOK = check(getRes, {
      "GET status == 200": (r) => r.status === 200,
      "GET duration < 300ms": (r) => r.timings.duration < 300,
    });
    get_ok.add(getOK);
    if (!getOK) fail(`GET must be 200 (got ${getRes.status})`);

    sleep(0.2);

    const updatePayload = JSON.stringify({
      price: Math.floor(Math.random() * 2000) + 50,
      description: `Updated by VU ${__VU} at ${Date.now()}`,
    });
    const putRes = http.put(`${PRODUCTS_URL}/${productId}`, updatePayload, {
      headers,
      tags: { endpoint: "products_update" },
    });
    const updateOK = check(putRes, {
      "PUT status == 200": (r) => r.status === 200,
      "PUT duration < 600ms": (r) => r.timings.duration < 600,
    });
    update_ok.add(updateOK);
    if (!updateOK) fail(`UPDATE must be 200 (got ${putRes.status})`);

    sleep(0.2);

    const delRes = http.del(`${PRODUCTS_URL}/${productId}`, null, {
      headers,
      tags: { endpoint: "products_delete" },
    });
    const deleteOK = check(delRes, {
      "DELETE status == 204": (r) => r.status === 204,
      "DELETE duration < 400ms": (r) => r.timings.duration < 400,
    });
    delete_ok.add(deleteOK);
    if (!deleteOK) fail(`DELETE must be 204 (got ${delRes.status})`);

    sleep(0.2);

    // Verify product delete (expect 404)
    const verifyRes = http.get(`${PRODUCTS_URL}/${productId}`, {
      headers,
      tags: { endpoint: "products_verify_delete" },
    });
    const verifyOK = check(verifyRes, {
      "VERIFY status == 404": (r) => r.status === 404,
    });
    if (!verifyOK) fail(`VERIFY must be 404 (got ${verifyRes.status})`);

    stepGetOK = getOK;
    stepUpdateOK = updateOK;
    stepDeleteOK = deleteOK && verifyOK;

    // Verify inventory also deleted (204 or 404 when re-get)
    const invAfter = http.get(`${INVENTORY_URL}/api/inventory/${productId}`, {
      headers,
      tags: { endpoint: "inventory_get_after_delete" },
    });
    const invGone = check(invAfter, {
      "inventory gone (404)": (r) => r.status === 404,
    });
    inventory_delete_ok.add(invGone);
    if (!invGone) {
      console.error(
        `Inventory delete sync failed: status=${invAfter.status} body=${invAfter.body}`
      );
      fail("Inventory must be removed after product deletion");
    }
    stepInventoryDeleteOK = invGone;
  });

  // Flow-level success: tất cả bước đều đúng kỳ vọng
  // Flow-level success: only require create, list and inventory verification in this script

  const allOK =
    stepCreateOK &&
    stepListOK &&
    stepInventoryCreateOK &&
    stepGetOK &&
    stepUpdateOK &&
    stepDeleteOK &&
    stepInventoryDeleteOK;
  flow_ok.add(allOK);
  if (!allOK) fail("FLOW FAIL");

  console.log(`[${FLOW_NAME}] VU ${__VU}: FLOW PASS`);
  sleep(1);
}
