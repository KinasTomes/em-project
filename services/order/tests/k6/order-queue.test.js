import http from 'k6/http'
import { check, fail, sleep, group } from 'k6'
import { Rate } from 'k6/metrics'

/**
 * K6 scenario to validate the full Outbox-driven order flow.
 * Steps per VU:
 *  1. Create an order via API Gateway / Order service.
 *  2. Poll the order status until Inventory events update it.
 *  3. Assert the final status reaches CONFIRMED (or surface failures).
 */

export const options = {
	scenarios: {
		smoke: {
			executor: 'per-vu-iterations',
			vus: Number(__ENV.VUS || 1),
			iterations: Number(__ENV.ITERATIONS || 1),
		},
	},
	thresholds: {
		http_req_failed: ['rate<0.05'],
		http_req_duration: ['p(95)<1500'],
		order_flow_success: ['rate==1'],
		order_status_confirmed: ['rate>0.95'],
	},
}

// Direct service URLs (no API Gateway required)
const AUTH_URL = __ENV.AUTH_URL || 'http://localhost:3001'
const PRODUCT_URL = __ENV.PRODUCT_URL || 'http://localhost:3004'
const ORDER_URL = __ENV.ORDER_URL || 'http://localhost:3002'
const PRODUCTS_URL = `${PRODUCT_URL}/api/products`
const ORDERS_URL = `${ORDER_URL}/api/orders`

const orderFlowSuccess = new Rate('order_flow_success')
const orderStatusConfirmed = new Rate('order_status_confirmed')

export function setup() {
	const loginPayload = JSON.stringify({
		username: 'testuser',
		password: 'testpass123',
	})

	const headersJson = { 'Content-Type': 'application/json' }
	const attemptLogin = () =>
		http.post(`${AUTH_URL}/login`, loginPayload, {
			headers: headersJson,
		})

	let loginRes = attemptLogin()
	const autoRegister = (__ENV.AUTO_REGISTER ?? 'true') !== 'false'

	if (loginRes.status !== 200 && autoRegister) {
		console.warn(
			'⚠️  [Setup] Login failed, attempting to auto-register credentials...'
		)
		const registerRes = http.post(`${AUTH_URL}/register`, loginPayload, {
			headers: headersJson,
		})
		check(registerRes, {
			'[Setup] Registration succeeded (201)': (r) => r.status === 201,
		})

		if (registerRes.status !== 201) {
			fail(
				`✗ [Setup] Registration failed (status ${registerRes.status}). Provide existing credentials or set AUTO_REGISTER=false.`
			)
		}

		loginRes = attemptLogin()
	}

	check(loginRes, {
		'[Setup] Login succeeded (200)': (r) => r.status === 200,
	})
	if (loginRes.status !== 200) {
		fail(
			`✗ [Setup] Login failed with status ${loginRes.status}. Ensure credentials exist or enable AUTO_REGISTER.`
		)
	}

	const token = JSON.parse(loginRes.body).token
	console.log('✓ [Setup] Login successful')

	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`,
	}

	// Create a seed product with healthy inventory to guarantee RESERVE success
	const productPayload = JSON.stringify({
		name: `k6-order-product-${Date.now()}`,
		description: 'Product created by k6 order flow test',
		price: 199.99,
		available: 10,
	})

	const productRes = http.post(PRODUCTS_URL, productPayload, { headers })
	check(productRes, {
		'[Setup] Product created (201)': (r) => r.status === 201,
		'[Setup] Product id present': (r) => {
			try {
				return Boolean(JSON.parse(r.body)._id)
			} catch (err) {
				console.error(`[Setup] Failed to parse product response: ${err}`)
				return false
			}
		},
	})

	const productId = JSON.parse(productRes.body)._id
	console.log(`✓ [Setup] Product ${productId} ready with available=10`)

	return { token, productId }
}

export default function (data) {
	const { token, productId } = data
	if (!token || !productId) {
		fail('✗ Missing setup data, aborting iteration')
	}

	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`,
	}

	group('Create order and await inventory confirmation', () => {
		const orderPayload = JSON.stringify({
			ids: [productId],
			quantities: [1],
		})

		const createRes = http.post(ORDERS_URL, orderPayload, {
			headers,
			tags: { name: 'create_order' },
		})

		const createOk = check(createRes, {
			'[Order] status 201': (r) => r.status === 201,
			'[Order] contains orderId': (r) => {
				try {
					return Boolean(JSON.parse(r.body).orderId)
				} catch (err) {
					console.error(`[Order] Failed to parse response: ${err}`)
					return false
				}
			},
			'[Order] initial status is PENDING': (r) => {
				try {
					return JSON.parse(r.body).status === 'PENDING'
				} catch {
					return false
				}
			},
		})

		if (!createOk) {
			orderFlowSuccess.add(false)
			fail('✗ Order creation failed')
		}

		const { orderId } = JSON.parse(createRes.body)
		console.log(`⏳ Waiting for inventory to confirm order ${orderId}`)

		const maxAttempts = Number(__ENV.POLL_ATTEMPTS || 12)
		const pollIntervalSeconds = Number(__ENV.POLL_INTERVAL || 2)
		let finalStatus = 'UNKNOWN'

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			sleep(pollIntervalSeconds)
			const statusRes = http.get(`${ORDERS_URL}/${orderId}`, {
				headers,
				tags: { name: 'get_order' },
			})

			if (statusRes.status !== 200) {
				console.warn(
					`⚠️  Attempt ${attempt}: unexpected status ${statusRes.status} when fetching order ${orderId}`
				)
				continue
			}

			try {
				const body = JSON.parse(statusRes.body)
				finalStatus = body.status
				console.log(
					`📦 Order ${orderId} polling attempt ${attempt}: status=${finalStatus}`
				)

				if (finalStatus === 'CONFIRMED' || finalStatus === 'PAID') {
					orderStatusConfirmed.add(1)
					orderFlowSuccess.add(1)
					return
				}

				if (finalStatus === 'CANCELLED') {
					orderStatusConfirmed.add(0)
					orderFlowSuccess.add(0)
					fail(
						`✗ Order ${orderId} cancelled: ${
							body?.reason || 'inventory failure'
						}`
					)
				}
			} catch (err) {
				console.error(`✗ Failed to parse order status response: ${err}`)
			}
		}

		orderStatusConfirmed.add(0)
		orderFlowSuccess.add(0)
		fail(
			`✗ Order ${orderId} did not reach CONFIRMED within ${
				maxAttempts * pollIntervalSeconds
			}s`
		)
	})
}

export function teardown(data) {
	const { token, productId } = data || {}
	if (!token || !productId) {
		console.log('⚠️  [Teardown] No cleanup performed')
		return
	}

	const headers = {
		Authorization: `Bearer ${token}`,
	}

	const deleteRes = http.del(`${PRODUCTS_URL}/${productId}`, null, { headers })
	if (deleteRes.status === 204) {
		console.log(`✓ [Teardown] Removed test product ${productId}`)
	} else {
		console.warn(
			`⚠️  [Teardown] Failed to delete product ${productId}, status ${deleteRes.status}`
		)
	}
}
