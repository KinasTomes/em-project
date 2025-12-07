/**
 * k6 Load Test: Case 1 - Order Creation Time (Event-Driven)
 *
 * Mục tiêu: Đo thời gian response khi tạo đơn hàng
 * - Với Event-Driven: Response trả ngay (async), xử lý background
 * - Target: < 400ms response time
 *
 * Số liệu thu thập:
 * - http_req_duration: Thời gian tạo đơn (TTFB)
 * - http_req_duration{p(50)}: Median latency
 * - http_req_duration{p(95)}: P95 latency
 * - http_req_duration{p(99)}: P99 latency
 * - http_req_failed: Tỷ lệ request fail
 * - http_reqs: Throughput (RPS)
 *
 * Cách chạy:
 *   # Test nhẹ (10 users, 30s)
 *   k6 run tests/k6/case1-order-creation.test.js
 *
 *   # Test nặng hơn (50 users, 1 phút)
 *   k6 run --vus 50 --duration 1m tests/k6/case1-order-creation.test.js
 *
 *   # Spike test (burst traffic)
 *   k6 run --env SCENARIO=spike tests/k6/case1-order-creation.test.js
 *
 *   # Với custom API endpoint
 *   k6 run --env API_BASE=http://136.110.42.41:3003 tests/k6/case1-order-creation.test.js
 */

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Trend, Counter, Rate } from 'k6/metrics'
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js'

// ============================================================================
// CONFIGURATION
// ============================================================================
const API_BASE = __ENV.API_BASE || 'http://localhost:3003'
const SCENARIO = __ENV.SCENARIO || 'normal'

// ============================================================================
// CUSTOM METRICS (Theo report.md Case 1)
// ============================================================================
const orderCreationTime = new Trend('order_creation_time', true) // Thời gian tạo đơn
const loginTime = new Trend('login_time', true)
const ordersCreated = new Counter('orders_created_total')
const ordersFailed = new Counter('orders_failed_total')
const orderSuccessRate = new Rate('order_success_rate')

// ============================================================================
// TEST OPTIONS
// ============================================================================
const scenarios = {
	// Test bình thường: 10 VUs, 30s
	normal: {
		stages: [
			{ duration: '5s', target: 10 }, // Ramp up
			{ duration: '30s', target: 10 }, // Steady
			{ duration: '5s', target: 0 }, // Ramp down
		],
	},
	// Stress test: Tăng dần đến 100 VUs
	stress: {
		stages: [
			{ duration: '10s', target: 20 },
			{ duration: '30s', target: 50 },
			{ duration: '30s', target: 100 },
			{ duration: '20s', target: 100 },
			{ duration: '10s', target: 0 },
		],
	},
	// Spike test: Đột ngột 200 users
	spike: {
		stages: [
			{ duration: '5s', target: 10 },
			{ duration: '5s', target: 200 }, // Spike!
			{ duration: '30s', target: 200 }, // Hold
			{ duration: '5s', target: 10 },
			{ duration: '5s', target: 0 },
		],
	},
}

export const options = {
	stages: scenarios[SCENARIO].stages,
	thresholds: {
		// Case 1 Targets (từ report.md)
		order_creation_time: [
			'p(50)<300', // Median < 300ms
			'p(95)<400', // P95 < 400ms (target trong report)
			'p(99)<800', // P99 < 800ms
		],
		http_req_duration: ['p(95)<500'],
		order_success_rate: ['rate>0.95'], // > 95% success
		http_req_failed: ['rate<0.05'], // < 5% failed
	},
	// Output summary
	summaryTrendStats: [
		'avg',
		'min',
		'med',
		'max',
		'p(50)',
		'p(90)',
		'p(95)',
		'p(99)',
	],
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function parseJson(response) {
	try {
		return JSON.parse(response.body)
	} catch (e) {
		return null
	}
}

// ============================================================================
// SETUP: Tạo user & product trước khi test
// ============================================================================
export function setup() {
	console.log(`\n🚀 Starting Case 1 Test - Order Creation Time`)
	console.log(`📍 API Base: ${API_BASE}`)
	console.log(`📊 Scenario: ${SCENARIO}`)
	console.log(`🎯 Target: Order creation < 400ms (P95)\n`)

	// 1. Register test user
	const username = `testuser_${randomString(8)}`
	const password = 'TestPass123!'

	const registerRes = http.post(
		`${API_BASE}/auth/register`,
		JSON.stringify({
			username: username,
			email: `${username}@test.com`,
			password: password,
		}),
		{ headers: { 'Content-Type': 'application/json' } }
	)

	if (registerRes.status !== 201 && registerRes.status !== 200) {
		console.error(
			`❌ Register failed: ${registerRes.status} - ${registerRes.body}`
		)
	}

	// 2. Login to get token
	const loginRes = http.post(
		`${API_BASE}/auth/login`,
		JSON.stringify({
			username: username,
			password: password,
		}),
		{ headers: { 'Content-Type': 'application/json' } }
	)

	const loginData = parseJson(loginRes)
	if (!loginData || !loginData.token) {
		console.error(`❌ Login failed: ${loginRes.status} - ${loginRes.body}`)
		return { token: null }
	}

	const token = loginData.token
	console.log(`✅ Test user created: ${username}`)

	// 3. Create test product (nếu có quyền)
	const productRes = http.post(
		`${API_BASE}/products`,
		JSON.stringify({
			name: `Test Product ${randomString(6)}`,
			description: 'Product for load testing',
			price: 99.99,
			stock: 10000, // Nhiều stock để test được lâu
			category: 'test',
		}),
		{
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
		}
	)

	const productData = parseJson(productRes)
	const productId = productData?._id || productData?.id || null

	if (productId) {
		console.log(`✅ Test product created: ${productId}`)
	} else {
		console.log(`⚠️ Could not create product, will use existing products`)
	}

	return {
		token: token,
		productId: productId,
		username: username,
	}
}

// ============================================================================
// MAIN TEST
// ============================================================================
export default function (data) {
	if (!data.token) {
		console.error('No token available, skipping test')
		return
	}

	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${data.token}`,
	}

	// Nếu không có productId từ setup, lấy product từ API
	let productId = data.productId

	if (!productId) {
		group('Get Product', () => {
			const productsRes = http.get(`${API_BASE}/products?limit=1`, {
				headers: headers,
				tags: { name: 'get_products' },
			})

			const products = parseJson(productsRes)
			if (products && products.length > 0) {
				productId = products[0]._id || products[0].id
			} else if (products && products.data && products.data.length > 0) {
				productId = products.data[0]._id || products.data[0].id
			}
		})
	}

	if (!productId) {
		console.error('No product available for testing')
		ordersFailed.add(1)
		orderSuccessRate.add(false)
		return
	}

	// =========================================================================
	// CORE TEST: Tạo Order và đo thời gian
	// =========================================================================
	group('Create Order', () => {
		const orderPayload = JSON.stringify({
			items: [
				{
					productId: productId,
					quantity: 1,
				},
			],
			// Thêm các field khác nếu cần
			shippingAddress: {
				street: '123 Test Street',
				city: 'Test City',
				country: 'VN',
			},
		})

		const startTime = Date.now()

		const response = http.post(`${API_BASE}/orders`, orderPayload, {
			headers: headers,
			tags: { name: 'create_order' },
		})

		const duration = Date.now() - startTime

		// Record metrics
		orderCreationTime.add(duration)

		// Validate response
		const success = check(response, {
			'Order created (2xx)': (r) => r.status >= 200 && r.status < 300,
			'Response has order ID': (r) => {
				const body = parseJson(r)
				return body && (body._id || body.id || body.orderId)
			},
			'Response time < 500ms': (r) => duration < 500,
			'Response time < 400ms (target)': (r) => duration < 400,
		})

		if (success) {
			ordersCreated.add(1)
			orderSuccessRate.add(true)
		} else {
			ordersFailed.add(1)
			orderSuccessRate.add(false)

			// Log error details
			if (response.status >= 400) {
				console.error(`Order failed: ${response.status} - ${response.body}`)
			}
		}
	})

	// Sleep giữa các iterations (simulate real user behavior)
	sleep(Math.random() * 2 + 1) // 1-3 seconds
}

// ============================================================================
// TEARDOWN: Cleanup sau test
// ============================================================================
export function teardown(data) {
	console.log(`\n📊 Test completed!`)
	console.log(`Check the summary below for Case 1 metrics.`)
}

// ============================================================================
// CUSTOM SUMMARY (Optional)
// ============================================================================
export function handleSummary(data) {
	const med = data.metrics.order_creation_time?.values?.med || 'N/A'
	const p95 = data.metrics.order_creation_time?.values['p(95)'] || 'N/A'
	const p99 = data.metrics.order_creation_time?.values['p(99)'] || 'N/A'
	const successRate = data.metrics.order_success_rate?.values?.rate || 0

	console.log(`
╔════════════════════════════════════════════════════════════════╗
║           CASE 1: ORDER CREATION TIME RESULTS                  ║
╠════════════════════════════════════════════════════════════════╣
║  Metric              │ Value        │ Target      │ Status     ║
╠══════════════════════╪══════════════╪═════════════╪════════════╣
║  Median (P50)        │ ${String(med).padEnd(12)} │ < 300ms     │ ${
		med < 300 ? '✅ PASS' : '❌ FAIL'
	}     ║
║  P95 Latency         │ ${String(p95).padEnd(12)} │ < 400ms     │ ${
		p95 < 400 ? '✅ PASS' : '❌ FAIL'
	}     ║
║  P99 Latency         │ ${String(p99).padEnd(12)} │ < 800ms     │ ${
		p99 < 800 ? '✅ PASS' : '❌ FAIL'
	}     ║
║  Success Rate        │ ${(successRate * 100).toFixed(
		1
	)}%        │ > 95%       │ ${successRate > 0.95 ? '✅ PASS' : '❌ FAIL'}     ║
╚════════════════════════════════════════════════════════════════╝
  `)

	return {
		stdout: JSON.stringify(data, null, 2),
		'results/case1-summary.json': JSON.stringify(data, null, 2),
	}
}
