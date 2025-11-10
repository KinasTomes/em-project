import http from "k6/http";
import { check, sleep, fail } from "k6";

export const options = {
  stages: [
    { duration: "10s", target: 1 },
    { duration: "20s", target: 3 },
    { duration: "10s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<750"],
  },
};

const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";
const INVENTORY_BASE_URL = __ENV.INVENTORY_URL || "http://localhost:3005";
const INVENTORY_API = `${INVENTORY_BASE_URL}/api/inventory`;

const HEX = "0123456789abcdef";
function randomObjectId() {
  let value = "";
  for (let i = 0; i < 24; i += 1) {
    value += HEX[Math.floor(Math.random() * HEX.length)];
  }
  return value;
}

function parseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch (err) {
    return null;
  }
}

export function setup() {
  const payload = JSON.stringify({
    username: "testuser",
    password: "testpass123",
  });

  const res = http.post(`${AUTH_URL}/login`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "auth_login" },
  });

  if (res.status !== 200) {
    fail(`Auth failed: status=${res.status}, body=${res.body}`);
  }

  const data = parseJson(res);
  if (!data?.token) {
    fail("Auth response did not include token");
  }

  return { token: data.token };
}

export default function (data) {
  if (!data?.token) {
    fail("Missing token in setup data");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
  };

  const productId = randomObjectId();
  let expectedAvailable = 60;
  let expectedReserved = 0;

  const createRes = http.post(
    INVENTORY_API,
    JSON.stringify({ productId, available: expectedAvailable }),
    { headers, tags: { name: "inventory_create" } }
  );
  const created = parseJson(createRes);
  check(createRes, {
    "create status 201": (r) => r.status === 201,
    "create available matches": () => created?.available === expectedAvailable,
  }) || fail(`inventory create failed: status=${createRes.status} body=${createRes.body}`);
  sleep(0.15);

  const getRes = http.get(`${INVENTORY_API}/${productId}`, {
    headers,
    tags: { name: "inventory_get" },
  });
  const fetched = parseJson(getRes);
  check(getRes, {
    "get status 200": (r) => r.status === 200,
    "get payload matches": () => fetched?.available === expectedAvailable,
  }) || fail(`inventory get failed: status=${getRes.status} body=${getRes.body}`);
  sleep(0.15);

  const listRes = http.get(`${INVENTORY_API}?page=1&limit=5`, {
    headers,
    tags: { name: "inventory_list" },
  });
  const listPayload = parseJson(listRes);
  check(listRes, {
    "list status 200": (r) => r.status === 200,
    "list contains product": () =>
      Array.isArray(listPayload?.items) &&
      listPayload.items.some((item) => item.productId === productId),
  });
  sleep(0.15);

  const availabilityRes = http.post(
    `${INVENTORY_API}/check-availability`,
    JSON.stringify({ productIds: [productId] }),
    { headers, tags: { name: "inventory_check_availability" } }
  );
  const availability = parseJson(availabilityRes);
  check(availabilityRes, {
    "availability status 200": (r) => r.status === 200,
    "availability matches": () =>
      Array.isArray(availability) &&
      availability[0]?.available === expectedAvailable,
  });
  sleep(0.15);

  const reserveQty = 15;
  const reserveRes = http.post(
    `${INVENTORY_API}/${productId}/reserve`,
    JSON.stringify({ quantity: reserveQty }),
    { headers, tags: { name: "inventory_reserve" } }
  );
  const reservePayload = parseJson(reserveRes);
  expectedAvailable -= reserveQty;
  expectedReserved += reserveQty;
  check(reserveRes, {
    "reserve status 200": (r) => r.status === 200,
    "reserve counts": () =>
      reservePayload?.inventory?.available === expectedAvailable &&
      reservePayload?.inventory?.reserved === expectedReserved,
  }) || fail(`inventory reserve failed: status=${reserveRes.status} body=${reserveRes.body}`);
  sleep(0.15);

  const releaseQty = 5;
  const releaseRes = http.post(
    `${INVENTORY_API}/${productId}/release`,
    JSON.stringify({ quantity: releaseQty }),
    { headers, tags: { name: "inventory_release" } }
  );
  const releasePayload = parseJson(releaseRes);
  expectedAvailable += releaseQty;
  expectedReserved -= releaseQty;
  check(releaseRes, {
    "release status 200": (r) => r.status === 200,
    "release counts": () =>
      releasePayload?.inventory?.available === expectedAvailable &&
      releasePayload?.inventory?.reserved === expectedReserved,
  }) || fail(`inventory release failed: status=${releaseRes.status} body=${releaseRes.body}`);
  sleep(0.15);

  const confirmQty = reserveQty - releaseQty;
  if (confirmQty > 0) {
    const confirmRes = http.post(
      `${INVENTORY_API}/${productId}/confirm`,
      JSON.stringify({ quantity: confirmQty }),
      { headers, tags: { name: "inventory_confirm" } }
    );
    const confirmPayload = parseJson(confirmRes);
    expectedReserved -= confirmQty;
    check(confirmRes, {
      "confirm status 200": (r) => r.status === 200,
      "confirm cleared": () => confirmPayload?.inventory?.reserved === expectedReserved,
    }) || fail(`inventory confirm failed: status=${confirmRes.status} body=${confirmRes.body}`);
    sleep(0.15);
  }

  const restockQty = 25;
  const restockRes = http.post(
    `${INVENTORY_API}/${productId}/restock`,
    JSON.stringify({ quantity: restockQty }),
    { headers, tags: { name: "inventory_restock" } }
  );
  const restockPayload = parseJson(restockRes);
  expectedAvailable += restockQty;
  check(restockRes, {
    "restock status 200": (r) => r.status === 200,
    "restock counts": () => restockPayload?.inventory?.available === expectedAvailable,
  }) || fail(`inventory restock failed: status=${restockRes.status} body=${restockRes.body}`);
  sleep(0.15);

  const adjustDelta = -7;
  const adjustRes = http.patch(
    `${INVENTORY_API}/${productId}`,
    JSON.stringify({ availableDelta: adjustDelta }),
    { headers, tags: { name: "inventory_adjust" } }
  );
  const adjustPayload = parseJson(adjustRes);
  expectedAvailable += adjustDelta;
  check(adjustRes, {
    "adjust status 200": (r) => r.status === 200,
    "adjust counts": () => adjustPayload?.inventory?.available === expectedAvailable,
  }) || fail(`inventory adjust failed: status=${adjustRes.status} body=${adjustRes.body}`);
  sleep(0.15);

  const lowStockRes = http.get(
    `${INVENTORY_API}/alerts/low-stock?threshold=${expectedAvailable + 5}`,
    { headers, tags: { name: "inventory_low_stock" } }
  );
  const lowStockPayload = parseJson(lowStockRes);
  check(lowStockRes, {
    "low stock status 200": (r) => r.status === 200,
    "low stock contains": () =>
      Array.isArray(lowStockPayload?.items) &&
      lowStockPayload.items.some((item) => item.productId === productId),
  });
  sleep(0.15);

  const outStockRes = http.get(
    `${INVENTORY_API}/alerts/out-of-stock`,
    { headers, tags: { name: "inventory_out_of_stock" } }
  );
  const outStockPayload = parseJson(outStockRes);
  check(outStockRes, {
    "out of stock status 200": (r) => r.status === 200,
    "out of stock excludes": () =>
      Array.isArray(outStockPayload?.items) &&
      outStockPayload.items.every((item) => item.productId !== productId),
  });
  sleep(0.15);

  const deleteRes = http.del(`${INVENTORY_API}/${productId}`, null, {
    headers,
    tags: { name: "inventory_delete" },
  });
  check(deleteRes, {
    "delete status 204": (r) => r.status === 204,
  }) || fail(`inventory delete failed: status=${deleteRes.status} body=${deleteRes.body}`);
  sleep(0.1);

  const verifyRes = http.get(`${INVENTORY_API}/${productId}`, {
    headers,
    tags: { name: "inventory_verify_delete" },
  });
  check(verifyRes, {
    "verify status 404": (r) => r.status === 404,
  });

  sleep(0.3);
}
