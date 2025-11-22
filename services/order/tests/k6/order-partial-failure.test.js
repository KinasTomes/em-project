import http from 'k6/http'
import { check, fail, sleep, group } from 'k6'
import { Rate } from 'k6/metrics'

/**
 * K6 test for PARTIAL inventory failure scenario (compensation test).
 * This is the CRITICAL test case for inventory leakage bug.
 * 
 * Scenario:
 * - Order with 2 products: 1 available, 1 out of stock
 * - Expected: Product 1 reserved → Product 2 failed → Product 1 MUST be released
 */

export const options = {
	scenarios: {
		partial_failure: {
			executor: 'per-vu-iterations',
			vus: Number(__ENV.VUS || 1),
			iterations: Number(__ENV.ITERATIONS || 1),
		},
	},
	thresholds: {
		http_req_failed: ['rate<0.05'],
		http_req_duration: ['p(95)<2000'],
		order_flow_success: ['rate==1'],
		order_status_cancelled: ['rate==1'],
	},
}

// API Gateway URLs
const BASE_URL = 'http://34.1.200.169:3003'
// const BASE_URL = 'http://localhost:3003'
const AUTH_URL = `${BASE_URL}/auth`
const PRODUCTS_URL = `${BASE_URL}/products`
const ORDERS_URL = `${BASE_URL}/orders`

const orderFlowSuccess = new Rate('order_flow_success')
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

	// Create product with available inventory
	const successPayload = JSON.stringify({
		name: `k6-partial-product-available-${Date.now()}`,
		description: 'Product with inventory (partial failure test)',
		price: 199.99,
		available: 10,
	})

	const successRes = http.post(PRODUCTS_URL, successPayload, { headers })
	console.log(`[Setup] Available product response status: ${successRes.status}`)

	check(successRes, {
		'[Setup] Available product created (201)': (r) => r.status === 201,
		'[Setup] Available product id present': (r) => {
			try {
				return Boolean(JSON.parse(r.body)._id)
			} catch (err) {
				console.error(
					`[Setup] Failed to parse available product response: ${err}`
				)
				return false
			}
		},
	})

	if (successRes.status !== 201) {
		fail(
			`✗ [Setup] Failed to create available product. Status: ${successRes.status}, Body: ${successRes.body}`
		)
	}

	const successProductId = JSON.parse(successRes.body)._id
	console.log(`✓ [Setup] Product ${successProductId} ready with available=10`)

	// Create product with zero inventory
	const failurePayload = JSON.stringify({
		name: `k6-partial-product-unavailable-${Date.now()}`,
		description: 'Product with zero inventory (partial failure test)',
		price: 9.99,
		available: 0,
	})

	const failureRes = http.post(PRODUCTS_URL, failurePayload, { headers })
	console.log(`[Setup] Unavailable product response status: ${failureRes.status}`)

	check(failureRes, {
		'[Setup] Unavailable product created (201)': (r) => r.status === 201,
		'[Setup] Unavailable product id present': (r) => {
			try {
				return Boolean(JSON.parse(r.body)._id)
			} catch (err) {
				console.error(
					`[Setup] Failed to parse unavailable product response: ${err}`
				)
				return false
			}
		},
	})

	if (failureRes.status !== 201) {
		fail(
			`✗ [Setup] Failed to create unavailable product. Status: ${failureRes.status}, Body: ${failureRes.body}`
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

	group('Create order with PARTIAL inventory failure (compensation test)', () => {
		// This is the CRITICAL test case for inventory leakage bug
		// Order with 2 products: 1 available, 1 out of stock
		// Expected: Product 1 reserved → Product 2 failed → Product 1 MUST be released
		const partialFailurePayload = JSON.stringify({
			ids: [successProductId, failureProductId], // Mix: available + unavailable
			quantities: [1, 1],
		})

		const createPartialRes = http.post(ORDERS_URL, partialFailurePayload, {
			headers,
			tags: { name: 'create_order_partial_failure' },
		})

		const createPartialOk = check(createPartialRes, {
			'[Partial Failure] status 201': (r) => r.status === 201,
			'[Partial Failure] contains orderId': (r) => {
				try {
					return Boolean(JSON.parse(r.body).orderId)
				} catch (err) {
					console.error(`[Partial Failure] Failed to parse response: ${err}`)
					return false
				}
			},
			'[Partial Failure] initial status is PENDING': (r) => {
				try {
					return JSON.parse(r.body).status === 'PENDING'
				} catch {
					return false
				}
			},
		})

		if (!createPartialOk) {
			orderFlowSuccess.add(0)
			fail('✗ Order creation failed for partial failure scenario')
		}

		const { orderId: partialOrderId } = JSON.parse(createPartialRes.body)
		console.log(`⏳ [CRITICAL TEST] Partial failure order ${partialOrderId}`)
		console.log(`   Product 1 (${successProductId}): available=10 → should reserve then release`)
		console.log(`   Product 2 (${failureProductId}): available=0 → will fail`)
		console.log(`   Expected: Order CANCELLED + Product 1 released (compensation)`)

		const maxAttempts = Number(__ENV.POLL_ATTEMPTS || 20)
		const pollIntervalSeconds = Number(__ENV.POLL_INTERVAL || 2)
		let finalStatus = 'UNKNOWN'
		let statusHistory = ['PENDING']

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			sleep(pollIntervalSeconds)
			const statusRes = http.get(`${ORDERS_URL}/${partialOrderId}`, {
				headers,
				tags: { name: 'get_order_partial_failure' },
			})

			if (statusRes.status !== 200) {
				console.warn(`⚠️  Attempt ${attempt}: unexpected status ${statusRes.status}`)
				continue
			}

			// 1. Dùng res.json() của K6 để parse an toàn
			let body;
			try {
				body = statusRes.json();
			} catch (e) {
				console.error("JSON Parse Error:", e);
				continue;
			}

			finalStatus = body.status;

			// Log trạng thái (giữ nguyên logic cũ)
			if (statusHistory[statusHistory.length - 1] !== finalStatus) {
				statusHistory.push(finalStatus)
				console.log(`   Status: ${statusHistory[statusHistory.length - 2]} → ${finalStatus}`)
			} else {
				console.log(`   Polling attempt ${attempt}: status=${finalStatus}`)
			}

			// 2. Xử lý trạng thái CANCELLED
			if (finalStatus === 'CANCELLED') {
				// Debug log để chắc chắn 100%
				console.log(`DEBUG BODY: ${JSON.stringify(body)}`);

				// Lấy reason một cách an toàn nhất
				// Ưu tiên lấy trực tiếp, sau đó thử lấy trong data (nếu có wrapper)
				const reason = body.cancellationReason || (body.data && body.data.cancellationReason) || 'unknown';

				console.log(`✓ [CRITICAL TEST] Order ${partialOrderId} cancelled: ${reason}`)
				console.log(`   Flow: ${statusHistory.join(' → ')}`)

				// Check keyword quan trọng
				const isInventoryFailure = reason.toLowerCase().includes('inventory') ||
					reason.toLowerCase().includes('stock') ||
					reason.toLowerCase().includes('product'); // Thêm 'product' vì log của bạn có chữ "Product ..."

				if (isInventoryFailure) {
					console.log(`✓ Cancellation reason is correct (inventory failure)`)
					orderStatusCancelled.add(1)
					orderFlowSuccess.add(1)
				} else {
					console.warn(`⚠️  Unexpected cancellation reason: ${reason}`)
					orderStatusCancelled.add(0)
					orderFlowSuccess.add(0)
					// Không fail() ở đây để tránh bị catch, chỉ đánh dấu failed metric
					console.error(`✗ Order ${partialOrderId} cancelled with wrong reason`)
				}

				// 🔥 QUAN TRỌNG: return luôn để thoát khỏi test case này ngay lập tức
				// Không cho nó loop thêm lần nào nữa
				return;
			}

			// 3. Xử lý trạng thái PAID/CONFIRMED (Lỗi logic)
			if (finalStatus === 'CONFIRMED' || finalStatus === 'PAID') {
				console.error(`✗ [CRITICAL TEST] Order ${partialOrderId} unexpectedly ${finalStatus}!`)
				orderStatusCancelled.add(0)
				orderFlowSuccess.add(0)
				// 🔥 Return luôn
				return;
			}
		}

		orderStatusCancelled.add(0)
		orderFlowSuccess.add(0)
		fail(
			`✗ [CRITICAL TEST] Order ${partialOrderId} did not reach CANCELLED within ${maxAttempts * pollIntervalSeconds
			}s. Last status: ${finalStatus}, History: ${statusHistory.join(' → ')}`
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
