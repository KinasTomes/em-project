import http from "k6/http";import http from "k6/http";import http from "k6/http";

import { check, sleep } from "k6";

import { check, sleep } from "k6";import { check, sleep } from "k6";

/**

 * K6 Load Test for Inventory Service

 * Tests: CRUD operations + stock management

 *//**/**

export const options = {

  stages: [ * K6 Load Test for Inventory Service * K6 Load Test for Inventory Service

    { duration: "30s", target: 10 },

    { duration: "1m", target: 10 }, * Tests: CRUD operations + Stock management * Tests:

    { duration: "10s", target: 0 },

  ], */ * - CRUD operations on inventory

  thresholds: {

    http_req_duration: ["p(95)<500"], * - Stock operations (reserve, release, restock)

    http_req_failed: ["rate<0.1"],

  },export const options = { * - Event consumption (PRODUCT_CREATED, PRODUCT_DELETED from products queue)

};

  stages: [ * - Low stock alerts

const BASE_URL = __ENV.BASE_URL || "http://localhost:3005";

const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";    { duration: "30s", target: 10 }, // Ramp up to 10 users */

const INVENTORY_URL = `${BASE_URL}/api/inventory`;

    { duration: "1m", target: 10 }, // Stay at 10 users

export function setup() {

  const loginPayload = JSON.stringify({    { duration: "10s", target: 0 }, // Ramp down to 0 usersexport const options = {

    username: "testuser",

    password: "testpass123",  ],  stages: [

  });

  thresholds: {    { duration: "10s", target: 5 }, // Warm up

  const loginResponse = http.post(`${AUTH_URL}/login`, loginPayload, {

    headers: { "Content-Type": "application/json" },    http_req_duration: ["p(95)<500"], // 95% of requests should be below 500ms    { duration: "30s", target: 15 }, // Load

  });

    http_req_failed: ["rate<0.1"], // Less than 10% of requests should fail    { duration: "20s", target: 15 }, // Sustained

  if (loginResponse.status === 200) {

    const data = JSON.parse(loginResponse.body);  },    { duration: "10s", target: 0 }, // Cool down

    console.log("✓ Authentication successful");

    return { token: data.token };};  ],

  }

  thresholds: {

  console.error("✗ Authentication failed:", loginResponse.status);

  return { token: null };const BASE_URL = __ENV.BASE_URL || "http://localhost:3005";    http_req_duration: ["p(95)<1000"],

}

const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";    http_req_failed: ["rate<0.1"],

export default function (data) {

  if (!data.token) {    "http_req_duration{name:create}": ["p(95)<800"],

    console.error("No token available, skipping tests");

    return;// Setup function to get auth token before tests    "http_req_duration{name:reserve}": ["p(95)<600"],

  }

export function setup() {    "http_req_duration{name:release}": ["p(95)<500"],

  const headers = {

    "Content-Type": "application/json",  const loginPayload = JSON.stringify({    "http_req_duration{name:restock}": ["p(95)<700"],

    Authorization: `Bearer ${data.token}`,

  };    username: "testuser",  },



  const productId = `product-${Date.now()}-${__VU}`;    password: "testpass123",};



  // 1. Create inventory record  });

  const createPayload = JSON.stringify({

    productId,const INVENTORY_URL = __ENV.INVENTORY_URL || "http://localhost:3003/inventory";

    quantity: Math.floor(Math.random() * 100) + 50,

    reserved: 0,  const loginResponse = http.post(`${AUTH_URL}/login`, loginPayload, {const PRODUCT_URL = __ENV.PRODUCT_URL || "http://localhost:3003";

  });

    headers: { "Content-Type": "application/json" },const AUTH_URL = __ENV.AUTH_URL || "http://localhost:3001";

  const createRes = http.post(INVENTORY_URL, createPayload, { headers });

  check(createRes, {  });

    "POST /api/inventory - status 201/401/400": (r) =>

      r.status === 201 || r.status === 401 || r.status === 400,// Setup: Get token and create test products

    "POST /api/inventory - response time OK": (r) => r.timings.duration < 1000,

  });  if (loginResponse.status === 200) {export function setup() {



  sleep(0.5);    const data = JSON.parse(loginResponse.body);  // 1. Get auth token



  // 2. List inventory    console.log("✓ Authentication successful");  const loginPayload = JSON.stringify({

  const listRes = http.get(`${INVENTORY_URL}?page=1&limit=10`, { headers });

  check(listRes, {    return { token: data.token };    username: "testuser",

    "GET /api/inventory - status 200 or 401": (r) =>

      r.status === 200 || r.status === 401,  } else {    password: "testpass123",

    "GET /api/inventory - response time OK": (r) => r.timings.duration < 500,

  });    console.error("✗ Authentication failed:", loginResponse.status);  });



  sleep(0.3);    return { token: null };



  // 3. Get inventory by product ID  }  const loginResponse = http.post(`${AUTH_URL}/login`, loginPayload, {

  const getRes = http.get(`${INVENTORY_URL}/${productId}`, { headers });

  check(getRes, {}    headers: { "Content-Type": "application/json" },

    "GET /api/inventory/:id - status 200/401/404": (r) =>

      r.status === 200 || r.status === 401 || r.status === 404,  });

    "GET /api/inventory/:id - response time OK": (r) =>

      r.timings.duration < 300,export default function (data) {

  });

  if (!data.token) {  let token = null;

  sleep(0.3);

    console.error("No token available, skipping tests");  if (loginResponse.status === 200) {

  // 4. Reserve stock

  const reservePayload = JSON.stringify({ quantity: 5, orderId: `order-${Date.now()}` });    return;    const data = JSON.parse(loginResponse.body);

  const reserveRes = http.post(`${INVENTORY_URL}/${productId}/reserve`, reservePayload, {

    headers,  }    token = data.token;

  });

  check(reserveRes, {    console.log("✓ [Setup] Authentication successful");

    "POST /reserve - status 200/401/404/400": (r) =>

      r.status === 200 || r.status === 401 || r.status === 404 || r.status === 400,  const headers = {  } else {

    "POST /reserve - response time OK": (r) => r.timings.duration < 600,

  });    "Content-Type": "application/json",    console.log("⚠️  [Setup] Login failed, attempting registration...");



  sleep(0.5);    Authorization: `Bearer ${data.token}`,    const registerResponse = http.post(`${AUTH_URL}/register`, loginPayload, {



  // 5. Restock  };      headers: { "Content-Type": "application/json" },

  const restockPayload = JSON.stringify({ quantity: 20 });

  const restockRes = http.post(`${INVENTORY_URL}/${productId}/restock`, restockPayload, {    });

    headers,

  });  const testProductId = `product-${Date.now()}-${__VU}`;

  check(restockRes, {

    "POST /restock - status 200/401/404": (r) =>    if (registerResponse.status === 201) {

      r.status === 200 || r.status === 401 || r.status === 404,

    "POST /restock - response time OK": (r) => r.timings.duration < 600,  // 1. CREATE INVENTORY      const data = JSON.parse(registerResponse.body);

  });

  const inventoryPayload = JSON.stringify({      token = data.token;

  sleep(0.5);

    productId: testProductId,      console.log("✓ [Setup] Registration successful");

  // 6. Low stock alerts

  const lowStockRes = http.get(`${INVENTORY_URL}/alerts/low-stock`, { headers });    quantity: Math.floor(Math.random() * 100) + 50,    }

  check(lowStockRes, {

    "GET /alerts/low-stock - status 200 or 401": (r) =>    reserved: 0,  }

      r.status === 200 || r.status === 401,

    "GET /alerts/low-stock - response time OK": (r) => r.timings.duration < 500,  });

  });

  if (!token) {

  sleep(0.3);

  const createRes = http.post(`${BASE_URL}/api`, inventoryPayload, {    console.error("✗ [Setup] Authentication failed");

  // 7. Delete inventory record

  const deleteRes = http.del(`${INVENTORY_URL}/${productId}`, null, { headers });    headers,    return { token: null, testData: [] };

  check(deleteRes, {

    "DELETE /api/inventory/:id - status 204/401/404": (r) =>  });  }

      r.status === 204 || r.status === 401 || r.status === 404,

    "DELETE /api/inventory/:id - response time OK": (r) => r.timings.duration < 400,

  });

  check(createRes, {  const headers = {

  sleep(1);

}    "POST /api - status 201 or 401 or 400": (r) =>    "Content-Type": "application/json",


      r.status === 201 || r.status === 401 || r.status === 400,    Authorization: `Bearer ${token}`,

    "POST /api - response time OK": (r) => r.timings.duration < 1000,  };

  });

  // 2. Create test products (triggers PRODUCT_CREATED events to products queue)

  sleep(0.5);  const testData = [];

  for (let i = 0; i < 3; i++) {

  // 2. LIST ALL INVENTORY    const productPayload = JSON.stringify({

  const listRes = http.get(`${BASE_URL}/api?page=1&limit=10`, {      name: `Inventory-Test-Product-${i}-${Date.now()}`,

    headers,      price: Math.floor(Math.random() * 500) + 100,

  });      description: `Product for inventory testing ${i}`,

    });

  check(listRes, {

    "GET /api - status 200 or 401": (r) => r.status === 200 || r.status === 401,    const productRes = http.post(`${PRODUCT_URL}/product`, productPayload, {

    "GET /api - response time OK": (r) => r.timings.duration < 500,      headers,

  });    });



  sleep(0.3);    if (productRes.status === 201) {

      try {

  // 3. GET INVENTORY BY PRODUCT ID        const product = JSON.parse(productRes.body);

  const getRes = http.get(`${BASE_URL}/api/${testProductId}`, {        testData.push({

    headers,          productId: product._id,

  });          name: product.name,

        });

  check(getRes, {        console.log(`✓ [Setup] Created product: ${product._id}`);

    "GET /api/:productId - status 200 or 401 or 404": (r) =>      } catch (e) {

      r.status === 200 || r.status === 401 || r.status === 404,        console.error(`Failed to parse product ${i}:`, e);

    "GET /api/:productId - response time OK": (r) => r.timings.duration < 300,      }

  });    }

    sleep(0.3); // Wait for event processing

  sleep(0.3);  }



  // 4. RESERVE STOCK  console.log(`✓ [Setup] Created ${testData.length} test products`);

  const reservePayload = JSON.stringify({  console.log(

    quantity: 5,    "⏳ [Setup] Waiting 2s for PRODUCT_CREATED events to be consumed..."

    orderId: `order-${Date.now()}`,  );

  });  sleep(2); // Wait for inventory service to consume PRODUCT_CREATED events



  const reserveRes = http.post(  return { token, testData };

    `${BASE_URL}/api/${testProductId}/reserve`,}

    reservePayload,

    {export default function (data) {

      headers,  if (!data.token || data.testData.length === 0) {

    }    console.error("Setup failed, skipping tests");

  );    return;

  }

  check(reserveRes, {

    "POST /api/:productId/reserve - status 200 or 401 or 404 or 400": (r) =>  const headers = {

      r.status === 200 || r.status === 401 || r.status === 404 || r.status === 400,    "Content-Type": "application/json",

    "POST /api/:productId/reserve - response time OK": (r) =>    Authorization: `Bearer ${data.token}`,

      r.timings.duration < 600,  };

  });

  const randomProduct =

  sleep(0.5);    data.testData[Math.floor(Math.random() * data.testData.length)];

  const productId = randomProduct.productId;

  // 5. RESTOCK INVENTORY

  const restockPayload = JSON.stringify({  // 1. CREATE INVENTORY (or verify auto-created from event)

    quantity: 20,  const createPayload = JSON.stringify({

  });    productId: productId,

    available: Math.floor(Math.random() * 100) + 50,

  const restockRes = http.post(    reserved: 0,

    `${BASE_URL}/api/${testProductId}/restock`,    backorder: 0,

    restockPayload,  });

    {

      headers,  const createRes = http.post(`${INVENTORY_URL}/api/inventory`, createPayload, {

    }    headers,

  );    tags: { name: "create" },

  });

  check(restockRes, {

    "POST /api/:productId/restock - status 200 or 401 or 404": (r) =>  check(createRes, {

      r.status === 200 || r.status === 401 || r.status === 404,    "CREATE - status 201 or 400 (already exists)": (r) =>

    "POST /api/:productId/restock - response time OK": (r) =>      r.status === 201 || r.status === 400,

      r.timings.duration < 600,  });

  });

  sleep(0.5);

  sleep(0.5);

  // 2. GET INVENTORY BY PRODUCT ID

  // 6. CHECK LOW STOCK ALERTS  const getRes = http.get(

  const lowStockRes = http.get(`${BASE_URL}/api/alerts/low-stock`, {    `${INVENTORY_URL}/api/inventory/product/${productId}`,

    headers,    {

  });      headers,

    }

  check(lowStockRes, {  );

    "GET /api/alerts/low-stock - status 200 or 401": (r) =>

      r.status === 200 || r.status === 401,  check(getRes, {

    "GET /api/alerts/low-stock - response time OK": (r) =>    "GET BY PRODUCT - status 200": (r) => r.status === 200,

      r.timings.duration < 500,    "GET BY PRODUCT - has productId": (r) => {

  });      try {

        const body = JSON.parse(r.body);

  sleep(0.3);        return body.productId === productId;

      } catch {

  // 7. DELETE INVENTORY        return false;

  const deleteRes = http.del(`${BASE_URL}/api/${testProductId}`, null, {      }

    headers,    },

  });  });



  check(deleteRes, {  sleep(0.3);

    "DELETE /api/:productId - status 204 or 401 or 404": (r) =>

      r.status === 204 || r.status === 401 || r.status === 404,  // 3. CHECK AVAILABILITY

    "DELETE /api/:productId - response time OK": (r) =>  const checkRes = http.get(

      r.timings.duration < 400,    `${INVENTORY_URL}/api/inventory/${productId}/availability`,

  });    {

      headers,

  sleep(1);    }

}  );



// Teardown  check(checkRes, {

export function teardown(data) {    "CHECK AVAILABILITY - status 200": (r) => r.status === 200,

  console.log("✓ Inventory service tests completed");    "CHECK AVAILABILITY - has available": (r) => {

}      try {

        const body = JSON.parse(r.body);
        return body.available !== undefined;
      } catch {
        return false;
      }
    },
  });

  sleep(0.3);

  // 4. RESERVE STOCK
  const reserveQty = Math.floor(Math.random() * 5) + 1;
  const reservePayload = JSON.stringify({
    quantity: reserveQty,
  });

  const reserveRes = http.post(
    `${INVENTORY_URL}/api/inventory/${productId}/reserve`,
    reservePayload,
    {
      headers,
      tags: { name: "reserve" },
    }
  );

  const reserveSuccess = check(reserveRes, {
    "RESERVE - status 200 or 400": (r) => r.status === 200 || r.status === 400,
    "RESERVE - has message": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.message !== undefined;
      } catch {
        return false;
      }
    },
  });

  sleep(0.5);

  // 5. RELEASE RESERVED (if reserve was successful)
  if (reserveSuccess && reserveRes.status === 200) {
    const releasePayload = JSON.stringify({
      quantity: reserveQty,
    });

    const releaseRes = http.post(
      `${INVENTORY_URL}/api/inventory/${productId}/release`,
      releasePayload,
      {
        headers,
        tags: { name: "release" },
      }
    );

    check(releaseRes, {
      "RELEASE - status 200": (r) => r.status === 200,
      "RELEASE - success message": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.message && body.message.includes("released");
        } catch {
          return false;
        }
      },
    });

    sleep(0.3);
  }

  // 6. RESTOCK
  const restockQty = Math.floor(Math.random() * 50) + 10;
  const restockPayload = JSON.stringify({
    quantity: restockQty,
  });

  const restockRes = http.post(
    `${INVENTORY_URL}/api/inventory/${productId}/restock`,
    restockPayload,
    {
      headers,
      tags: { name: "restock" },
    }
  );

  check(restockRes, {
    "RESTOCK - status 200": (r) => r.status === 200,
    "RESTOCK - success message": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.message && body.message.includes("restocked");
      } catch {
        return false;
      }
    },
  });

  sleep(0.5);

  // 7. GET LOW STOCK ALERTS
  const lowStockRes = http.get(
    `${INVENTORY_URL}/api/inventory/alerts/low-stock?threshold=20`,
    {
      headers,
    }
  );

  check(lowStockRes, {
    "LOW STOCK - status 200": (r) => r.status === 200,
    "LOW STOCK - is array": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch {
        return false;
      }
    },
  });

  sleep(0.3);

  // 8. LIST ALL INVENTORY
  const listRes = http.get(`${INVENTORY_URL}/api/inventory`, {
    headers,
  });

  check(listRes, {
    "LIST ALL - status 200": (r) => r.status === 200,
    "LIST ALL - is array": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}

// Teardown: Clean up test data
export function teardown(data) {
  if (!data.token || !data.testData || data.testData.length === 0) {
    console.log("⚠️  [Teardown] No cleanup needed");
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
  };

  // Delete test products (triggers PRODUCT_DELETED events)
  let deletedCount = 0;
  for (const item of data.testData) {
    const deleteRes = http.del(
      `${PRODUCT_URL}/product/${item.productId}`,
      null,
      {
        headers,
      }
    );
    if (deleteRes.status === 204) {
      deletedCount++;
      console.log(`✓ [Teardown] Deleted product: ${item.productId}`);
    }
    sleep(0.2);
  }

  console.log(
    `✓ [Teardown] Cleaned up ${deletedCount}/${data.testData.length} test products`
  );
  console.log(
    "⏳ [Teardown] Waiting 2s for PRODUCT_DELETED events to be consumed..."
  );
  sleep(2); // Wait for inventory service to consume PRODUCT_DELETED events

  console.log("✓ [Teardown] Inventory service tests completed");
  console.log(
    "📊 [Note] Check Inventory service logs for event consumption stats"
  );
}
