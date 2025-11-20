import http from 'k6/http'
import { check, sleep, group, fail } from 'k6'
import { Rate } from 'k6/metrics'

// ==== Custom metrics ====
const auth_ok = new Rate('auth_ok')
const product_create_ok = new Rate('product_create_ok')
const order_create_ok = new Rate('order_create_ok')
const order_flow_ok = new Rate('order_flow_ok')

export const options = {
	stages: [
		{ duration: '30s', target: 10 },
		{ duration: '1m', target: 10 },
		{ duration: '10s', target: 0 },
	],
	thresholds: {
		http_req_duration: ['p(95)<500'],
		http_req_failed: ['rate<0.1'],

		// Bắt buộc đúng tuyệt đối
		auth_ok: ['rate==1.0'],
		product_create_ok: ['rate==1.0'],
		order_create_ok: ['rate==1.0'],
		order_flow_ok: ['rate==1.0'],
	},
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3003'
const AUTH_URL = `${BASE_URL}/auth`
const PRODUCTS_URL = `${BASE_URL}/products`
const ORDERS_URL = `${BASE_URL}/orders`

const AUTO_REGISTER = (__ENV.AUTO_REGISTER ?? 'true') !== 'false'

function loginOrRegister(credentials) {
	const headers = { 'Content-Type': 'application/json' }
	let loginRes = http.post(`${AUTH_URL}/login`, credentials, {
		headers,
		tags: { endpoint: 'auth_login' },
		timeout: '10s',
	})

	if (loginRes.status !== 200 && AUTO_REGISTER) {
		console.warn('⚠️ Login failed, attempting auto-register...')
		const registerRes = http.post(`${AUTH_URL}/register`, credentials, {
			headers,
			tags: { endpoint: 'auth_register' },
			timeout: '10s',
		})

		check(registerRes, {
			'[Setup] Registration succeeded (201)': (r) => r.status === 201,
		})

		if (registerRes.status !== 201) {
			fail(
				`Registration failed (status ${registerRes.status}). Provide existing credentials or set AUTO_REGISTER=false.`
			)
		}

		loginRes = http.post(`${AUTH_URL}/login`, credentials, {
			headers,
			tags: { endpoint: 'auth_login' },
			timeout: '10s',
		})
	}

	check(loginRes, {
		'[Setup] Login succeeded (200)': (r) => r.status === 200,
	})

	if (loginRes.status !== 200) {
		fail(
			`Login failed with status ${loginRes.status}. Ensure credentials exist or enable AUTO_REGISTER.`
		)
	}

	return loginRes
}

// ============= SETUP =============
export function setup() {
	console.log(`🔍 Using API Gateway: ${BASE_URL}`)

	// 1) Login (auto-register if needed)
	const loginPayload = JSON.stringify({
		username: 'testuser',
		password: 'testpass123',
	})

	const loginRes = loginOrRegister(loginPayload)
	const okAuth = loginRes.status === 200
	auth_ok.add(okAuth)

	const { token } = JSON.parse(loginRes.body)
	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`,
	}

	// 2) Tạo 3 product test trực tiếp (bắt buộc 201)
	const productIds = []
	for (let i = 0; i < 3; i++) {
		const payload = JSON.stringify({
			name: `Test Product ${Date.now()}-${i}`,
			price: Math.floor(Math.random() * 1000) + 50,
			description: 'Test product for order integration test',
			available: 10,
		})

		const res = http.post(PRODUCTS_URL, payload, {
			headers,
			tags: { endpoint: 'products_create' },
			timeout: '10s', // Add timeout
		})

		// Check for connection errors first
		if (res.status === 0) {
			const errorMsg = `Connection error: Cannot reach ${PRODUCTS_URL}. Status: ${
				res.status
			}, Error: ${
				res.error || 'Connection refused'
			}. Please ensure API Gateway and Product Service are running.`
			console.error(`❌ ${errorMsg}`)
			fail(errorMsg)
		}

		// Check for service unavailable (503)
		if (res.status === 503) {
			const errorMsg = `Service Unavailable (503): Product Service is not running or not accessible. Response: ${
				res.body || 'No response'
			}`
			console.error(`❌ ${errorMsg}`)
			fail(errorMsg)
		}

		const okCreate = check(res, {
			'CREATE PRODUCT status == 201': (r) => r.status === 201,
			'CREATE PRODUCT duration < 1000ms': (r) => r.timings.duration < 1000,
		})
		product_create_ok.add(okCreate)

		if (!okCreate) {
			const errorMsg = `Product create must be 201. Got ${res.status} - ${
				res.body || res.error || 'No response'
			}`
			console.error(`❌ ${errorMsg}`)
			fail(errorMsg)
		}

		try {
			const prod = JSON.parse(res.body)
			productIds.push(prod._id)
			console.log(`✓ Created test product: ${prod._id}`)
		} catch (e) {
			fail(`Cannot parse product body: ${e}. Response body: ${res.body}`)
		}
	}

	console.log(`✓ Setup complete. Created ${productIds.length} test products`)
	return { token, productIds }
}

// ============= DEFAULT (VU) =============
export default function (data) {
	if (!data?.token || data.productIds.length === 0) {
		fail('No token or no products from setup')
	}

	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${data.token}`,
	}

	// Chọn ngẫu nhiên 1..N sản phẩm để tạo order
	const count = Math.floor(Math.random() * data.productIds.length) + 1
	const selected = data.productIds.slice(0, count)
	const orderPayload = JSON.stringify({ ids: selected })

	group('CREATE ORDER (expect 201 + has orderId)', () => {
		const res = http.post(ORDERS_URL, orderPayload, {
			headers,
			tags: { endpoint: 'orders_create' },
			timeout: '10s', // Add timeout
		})

		const ok = check(res, {
			'ORDER status == 201': (r) => r.status === 201,
			'ORDER has orderId': (r) => {
				if (r.status !== 201) return false
				try {
					const body = JSON.parse(r.body)
					return body.orderId !== undefined
				} catch {
					return false
				}
			},
			'ORDER duration < 1000ms': (r) => r.timings.duration < 1000,
		})

		order_create_ok.add(ok)

		if (!ok) {
			fail(`Order must be 201 with orderId. Got ${res.status} - ${res.body}`)
		}

		const body = JSON.parse(res.body)
		console.log(
			`✓ Created order ${body.orderId} with ${
				body.products?.length ?? '?'
			} products, total: $${body.totalPrice}`
		)
		order_flow_ok.add(true)
	})

	sleep(1)
}

// ============= TEARDOWN =============
export function teardown(data) {
	if (!data?.token || data.productIds.length === 0) return

	const headers = { Authorization: `Bearer ${data.token}` }
	console.log(`Cleaning up ${data.productIds.length} test products...`)

	let deleted = 0
	for (const pid of data.productIds) {
		const res = http.del(`${PRODUCTS_URL}/${pid}`, null, {
			headers,
			tags: { endpoint: 'products_delete' },
		})
		if (res.status === 204) deleted++
		else console.warn(`Delete product ${pid} => ${res.status} - ${res.body}`)
	}

	console.log(
		`✓ Teardown complete. Deleted ${deleted}/${data.productIds.length} products`
	)
}
