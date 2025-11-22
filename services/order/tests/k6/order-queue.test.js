import http from 'k6/http'
import { check, fail, sleep, group } from 'k6'
import { Rate } from 'k6/metrics'

/**
 * K6 scenarios to validate the full SAGA order flow.
 * Steps per VU:
 *  1. Create an order with sufficient inventory (should reach PAID or CANCELLED by payment).
 *  2. Create another order with zero inventory to force INVENTORY_RESERVE_FAILED.
 *  3. Poll each order until their expected terminal status:
 *     - Order 1: PAID (payment success) or CANCELLED (payment failure ~10%)
 *     - Order 2: CANCELLED (inventory failure)
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
		http_req_duration: ['p(95)<2000'], // Increased for payment processing
		order_flow_success: ['rate==1'],
		order_status_confirmed: ['rate>0.85'], // Adjusted for payment success rate (90%)
		order_status_cancelled: ['rate>0.95'],
	},
}

// API Gateway URLs (E2E path - mô phỏng client thực tế)
// const BASE_URL = 'http://localhost:3003'
const BASE_URL = 'http://34.1.200.169:3003'
const AUTH_URL = `${BASE_URL}/auth`
const PRODUCTS_URL = `${BASE_URL}/products`
const ORDERS_URL = `${BASE_URL}/orders`

const orderFlowSuccess = new Rate('order_flow_success')
const orderStatusConfirmed = new Rate('order_status_confirmed')
const orderStatusCancelled = new Rate('order_status_cancelled')

// Setup: Create test products and get token
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
	const successPayload = JSON.stringify({
		name: `k6-order-product-success-${Date.now()}`,
		description: 'Product created by k6 order flow test (success path)',
		price: 199.99,
		available: 10,
	})

	const successRes = http.post(PRODUCTS_URL, successPayload, { headers })
	console.log(`[Setup] Success product response status: ${successRes.status}`)
	console.log(`[Setup] Success product response body: ${successRes.body}`)

	check(successRes, {
		'[Setup] Success product created (201)': (r) => r.status === 201,
		'[Setup] Success product id present': (r) => {
			try {
				return Boolean(JSON.parse(r.body)._id)
			} catch (err) {
				console.error(
					`[Setup] Failed to parse success product response: ${err}`
				)
				return false
			}
		},
	})

	if (successRes.status !== 201) {
		fail(
			`✗ [Setup] Failed to create success product. Status: ${successRes.status}, Body: ${successRes.body}`
		)
	}

	const successProductId = JSON.parse(successRes.body)._id
	console.log(`✓ [Setup] Product ${successProductId} ready with available=10`)

	// Create a second product with zero inventory to force INVENTORY_RESERVE_FAILED
	const failurePayload = JSON.stringify({
		name: `k6-order-product-failure-${Date.now()}`,
		description: 'Product created by k6 order flow test (failure path)',
		price: 9.99,
		available: 0,
	})

	const failureRes = http.post(PRODUCTS_URL, failurePayload, { headers })
	console.log(`[Setup] Failure product response status: ${failureRes.status}`)
	console.log(`[Setup] Failure product response body: ${failureRes.body}`)

	check(failureRes, {
		'[Setup] Failure product created (201)': (r) => r.status === 201,
		'[Setup] Failure product id present': (r) => {
			try {
				return Boolean(JSON.parse(r.body)._id)
			} catch (err) {
				console.error(
					`[Setup] Failed to parse failure product response: ${err}`
				)
				return false
			}
		},
	})

	if (failureRes.status !== 201) {
		fail(
			`✗ [Setup] Failed to create failure product. Status: ${failureRes.status}, Body: ${failureRes.body}`
		)
	}

	const failureProductId = JSON.parse(failureRes.body)._id
	console.log(`✓ [Setup] Product ${failureProductId} ready with available=0`)

	return { token, successProductId, failureProductId }
}

export default function (data) {
	const { token, successProductId, failureProductId } = data
	if (!token || !successProductId || !failureProductId) {
		fail('✗ Missing setup data, aborting iteration')
	}

	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`,
	}

	group('Create order and await full SAGA completion (PAID or CANCELLED)', () => {
		const orderPayload = JSON.stringify({
			ids: [successProductId],
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
		console.log(`⏳ Waiting for full SAGA flow: ${orderId} → PENDING → CONFIRMED → PAID/CANCELLED`)

		const maxAttempts = Number(__ENV.POLL_ATTEMPTS || 20) // Increased for payment processing
		const pollIntervalSeconds = Number(__ENV.POLL_INTERVAL || 2)
		let finalStatus = 'UNKNOWN'
		let statusHistory = ['PENDING']

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
				
				// Track status changes
				if (statusHistory[statusHistory.length - 1] !== finalStatus) {
					statusHistory.push(finalStatus)
					console.log(`✓ Order ${orderId} status changed: ${statusHistory[statusHistory.length - 2]} → ${finalStatus}`)
				} else {
					console.log(`📦 Order ${orderId} polling attempt ${attempt}: status=${finalStatus}`)
				}

				// Check for final states
				if (finalStatus === 'PAID') {
					console.log(`✓ Order ${orderId} reached PAID (payment succeeded)`)
					console.log(`  Flow: ${statusHistory.join(' → ')}`)
					orderStatusConfirmed.add(1)
					orderFlowSuccess.add(1)
					return
				}

				if (finalStatus === 'CANCELLED') {
					const reason = body.cancellationReason || 'unknown'
					console.log(`⚠️  Order ${orderId} cancelled: ${reason}`)
					console.log(`  Flow: ${statusHistory.join(' → ')}`)
					
					// Check if cancellation is due to payment failure (expected)
					if (reason.toLowerCase().includes('payment')) {
						console.log(`  Note: Payment failure is expected (90% success rate)`)
						orderStatusConfirmed.add(1) // Still counts as successful flow
						orderFlowSuccess.add(1)
						return
					} else {
						// Unexpected cancellation (inventory should not fail with available=10)
						orderStatusConfirmed.add(0)
						orderFlowSuccess.add(0)
						fail(`✗ Order ${orderId} cancelled unexpectedly: ${reason}`)
					}
				}
			} catch (err) {
				console.error(`✗ Failed to parse order status response: ${err}`)
			}
		}

		orderStatusConfirmed.add(0)
		orderFlowSuccess.add(0)
		fail(
			`✗ Order ${orderId} did not reach final state (PAID/CANCELLED) within ${
				maxAttempts * pollIntervalSeconds
			}s. Last status: ${finalStatus}, History: ${statusHistory.join(' → ')}`
		)
	})

	group('Create order that should fail inventory reservation (all products unavailable)', () => {
		const failureOrderPayload = JSON.stringify({
			ids: [failureProductId],
			quantities: [1],
		})

		const createFailureRes = http.post(ORDERS_URL, failureOrderPayload, {
			headers,
			tags: { name: 'create_order_failure' },
		})

		const createFailureOk = check(createFailureRes, {
			'[Order Failure] status 201': (r) => r.status === 201,
			'[Order Failure] contains orderId': (r) => {
				try {
					return Boolean(JSON.parse(r.body).orderId)
				} catch (err) {
					console.error(`[Order Failure] Failed to parse response: ${err}`)
					return false
				}
			},
			'[Order Failure] initial status is PENDING': (r) => {
				try {
					return JSON.parse(r.body).status === 'PENDING'
				} catch {
					return false
				}
			},
		})

		if (!createFailureOk) {
			orderFlowSuccess.add(0)
			fail('✗ Order creation failed for failure scenario')
		}

		const { orderId: failureOrderId } = JSON.parse(createFailureRes.body)
		console.log(
			`⏳ Waiting for inventory to cancel order ${failureOrderId} via INVENTORY_RESERVE_FAILED`
		)

		const maxAttempts = Number(__ENV.POLL_ATTEMPTS || 12)
		const pollIntervalSeconds = Number(__ENV.POLL_INTERVAL || 2)
		let finalStatus = 'UNKNOWN'

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			sleep(pollIntervalSeconds)
			const statusRes = http.get(`${ORDERS_URL}/${failureOrderId}`, {
				headers,
				tags: { name: 'get_order_failure' },
			})

			if (statusRes.status !== 200) {
				console.warn(
					`⚠️  Attempt ${attempt}: unexpected status ${statusRes.status} when fetching order ${failureOrderId}`
				)
				continue
			}

			try {
				const body = JSON.parse(statusRes.body)
				finalStatus = body.status
				console.log(
					`📦 Order ${failureOrderId} (failure flow) polling attempt ${attempt}: status=${finalStatus}`
				)

				if (finalStatus === 'CANCELLED') {
					orderStatusCancelled.add(1)
					orderFlowSuccess.add(1)
					return
				}

				if (finalStatus === 'CONFIRMED' || finalStatus === 'PAID') {
					orderStatusCancelled.add(0)
					orderFlowSuccess.add(0)
					fail(
						`✗ Order ${failureOrderId} unexpectedly ${finalStatus} despite zero inventory`
					)
				}
			} catch (err) {
				console.error(
					`✗ Failed to parse order status response for failure flow: ${err}`
				)
			}
		}

		orderStatusCancelled.add(0)
		orderFlowSuccess.add(0)
		fail(
			`✗ Order ${failureOrderId} did not reach CANCELLED within ${
				maxAttempts * pollIntervalSeconds
			}s`
		)
	})
}

export function teardown(data) {
	const { token, successProductId, failureProductId } = data || {}
	if (!token) {
		console.log('⚠️  [Teardown] Missing auth token, no cleanup performed')
		return
	}

	const headers = {
		Authorization: `Bearer ${token}`,
	}

	const idsToDelete = [successProductId, failureProductId].filter(Boolean)
	if (!idsToDelete.length) {
		console.log('⚠️  [Teardown] No product ids provided for cleanup')
		return
	}

	idsToDelete.forEach((id) => {
		const deleteRes = http.del(`${PRODUCTS_URL}/${id}`, null, { headers })
		if (deleteRes.status === 204) {
			console.log(`✓ [Teardown] Removed test product ${id}`)
		} else {
			console.warn(
				`⚠️  [Teardown] Failed to delete product ${id}, status ${deleteRes.status}`
			)
		}
	})
}
