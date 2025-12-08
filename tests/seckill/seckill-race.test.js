import http from 'k6/http'
import { check, sleep, fail } from 'k6'
import { SharedArray } from 'k6/data'
import { Counter, Rate, Trend } from 'k6/metrics'

/**
 * Seckill Race Condition Test
 * 
 * Scenario:
 * 1. Admin khởi tạo flash sale với stock = 1
 * 2. 2 users đồng thời cố mua sản phẩm
 * 3. Chỉ 1 user thành công, 1 user nhận OUT_OF_STOCK
 * 
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:3003 tests/seckill/seckill-race.test.js
 *   k6 run -e BASE_URL=http://34.2.136.15:3003 tests/seckill/seckill-race.test.js
 */

// Custom metrics
const seckillSuccess = new Counter('seckill_success')
const seckillOutOfStock = new Counter('seckill_out_of_stock')
const seckillDuplicate = new Counter('seckill_duplicate')
const seckillErrors = new Counter('seckill_errors')
const seckillLatency = new Trend('seckill_latency')
const seckillSuccessRate = new Rate('seckill_success_rate')

export const options = {
	scenarios: {
		// 2 VUs race cùng lúc
		race_condition: {
			executor: 'shared-iterations',
			vus: 2,
			iterations: 2,
			maxDuration: '30s',
		},
	},
	thresholds: {
		// Chỉ 1 trong 2 người mua được (50% success rate với stock=1, 2 buyers)
		seckill_success: ['count==1'],
		seckill_out_of_stock: ['count==1'],
		seckill_errors: ['count==0'],
	},
}

const BASE_URL = __ENV.BASE_URL || 'http://34.2.136.15:3003'
const ADMIN_KEY = __ENV.ADMIN_KEY || 'super-gay-key-for-femboi-usage'

// Shared data between VUs
let testData = null

/**
 * Setup: Đăng ký 2 users và khởi tạo flash sale campaign
 */
export function setup() {
	console.log(`\n🎯 Seckill Race Test - BASE_URL: ${BASE_URL}`)
	
	const headers = { 'Content-Type': 'application/json' }
	const users = []
	let userToken = null

	// 1. Tạo 2 test users (cần token trước để có thể tạo product)
	for (let i = 1; i <= 2; i++) {
		const username = `seckill_user_${Date.now()}_${i}`
		const password = 'testpass123'
		const credentials = JSON.stringify({ username, password })

		// Register
		let registerRes = http.post(`${BASE_URL}/auth/register`, credentials, { headers })
		
		if (registerRes.status !== 201) {
			// Có thể user đã tồn tại, thử login
			console.log(`⚠️  User ${i} registration returned ${registerRes.status}, trying login...`)
		}

		// Login
		const loginRes = http.post(`${BASE_URL}/auth/login`, credentials, { headers })
		
		if (loginRes.status !== 200) {
			fail(`❌ User ${i} login failed: ${loginRes.status} - ${loginRes.body}`)
		}

		const token = JSON.parse(loginRes.body).token
		users.push({ username, token })
		console.log(`✓ User ${i} ready: ${username}`)
		
		// Store first user's token for product operations
		if (i === 1) userToken = token
	}

	// 2. Fetch or create a real product
	console.log(`\n📦 Fetching or creating product...`)
	
	let PRODUCT_ID = null
	let PRODUCT_PRICE = 99.99

	// Try to fetch existing products (with auth)
	const authHeaders = { 
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${userToken}`
	}
	
	const productsRes = http.get(`${BASE_URL}/products`, { headers: authHeaders })
	
	if (productsRes.status === 200) {
		let products = []
		try {
			products = JSON.parse(productsRes.body)
		} catch (e) {
			console.log(`⚠️ Failed to parse products response`)
		}

		if (products && products.length > 0) {
			const product = products[0]
			PRODUCT_ID = product._id
			PRODUCT_PRICE = product.price || 99.99
			console.log(`✓ Found existing product: ${product.name}`)
			console.log(`  ID: ${PRODUCT_ID}`)
			console.log(`  Price: ${PRODUCT_PRICE}`)
		}
	}

	// If no product found, create one
	if (!PRODUCT_ID) {
		console.log(`Creating new test product...`)
		
		const newProduct = JSON.stringify({
			name: `Seckill Test Product ${Date.now()}`,
			price: 99.99,
			description: 'Test product for seckill race condition test',
			stock: 100
		})

		const createRes = http.post(`${BASE_URL}/products`, newProduct, { headers: authHeaders })
		
		if (createRes.status === 201 || createRes.status === 200) {
			const created = JSON.parse(createRes.body)
			PRODUCT_ID = created._id
			PRODUCT_PRICE = created.price || 99.99
			console.log(`✓ Created new product: ${created.name}`)
			console.log(`  ID: ${PRODUCT_ID}`)
			console.log(`  Price: ${PRODUCT_PRICE}`)
		} else {
			fail(`❌ Failed to create product: ${createRes.status} - ${createRes.body}`)
		}
	}

	if (!PRODUCT_ID) {
		fail(`❌ No product available for testing`)
	}

	// 3. Khởi tạo flash sale campaign với stock = 1
	const now = new Date()
	const startTime = new Date(now.getTime() - 60000).toISOString() // Started 1 min ago
	const endTime = new Date(now.getTime() + 3600000).toISOString() // Ends in 1 hour

	const campaignPayload = JSON.stringify({
		productId: PRODUCT_ID,
		stock: 1,  // Chỉ 1 sản phẩm
		price: PRODUCT_PRICE,
		startTime,
		endTime,
	})

	const initRes = http.post(`${BASE_URL}/admin/seckill/init`, campaignPayload, {
		headers: {
			'Content-Type': 'application/json',
			'X-Admin-Key': ADMIN_KEY,
		},
	})

	console.log(`\n📢 Campaign init response: ${initRes.status}`)
	console.log(`   Body: ${initRes.body}`)

	if (initRes.status !== 200 && initRes.status !== 201) {
		fail(`❌ Failed to initialize campaign: ${initRes.status} - ${initRes.body}`)
	}

	console.log(`\n✓ Flash sale initialized:`)
	console.log(`  - Product: ${PRODUCT_ID}`)
	console.log(`  - Stock: 1`)
	console.log(`  - Price: $${PRODUCT_PRICE}`)
	console.log(`  - Start: ${startTime}`)
	console.log(`  - End: ${endTime}`)

	// 3. Verify campaign status
	sleep(0.5)
	const statusRes = http.get(`${BASE_URL}/seckill/status/${PRODUCT_ID}`)
	console.log(`\n📊 Campaign status: ${statusRes.body}`)

	return { users, productId: PRODUCT_ID }
}

/**
 * Main test: 2 VUs race to buy the same product
 */
export default function(data) {
	const { users, productId } = data
	const vuId = __VU // VU number (1 or 2)
	const user = users[vuId - 1]

	if (!user) {
		console.error(`❌ No user data for VU ${vuId}`)
		seckillErrors.add(1)
		return
	}

	console.log(`\n🏃 VU ${vuId} (${user.username}) attempting to buy...`)

	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${user.token}`,
	}

	const buyPayload = JSON.stringify({ productId })

	const startTime = Date.now()
	const res = http.post(`${BASE_URL}/seckill/buy`, buyPayload, { headers })
	const latency = Date.now() - startTime

	seckillLatency.add(latency)

	console.log(`\n📬 VU ${vuId} Response:`)
	console.log(`   Status: ${res.status}`)
	console.log(`   Body: ${res.body}`)
	console.log(`   Latency: ${latency}ms`)

	// Parse response
	let body = {}
	try {
		body = JSON.parse(res.body)
	} catch (e) {
		console.error(`❌ Failed to parse response: ${res.body}`)
	}

	// Check results
	// 200/201/202 are all success statuses (202 = Accepted for async processing)
	if (res.status === 200 || res.status === 201 || res.status === 202) {
		// Success - got the product!
		const success = check(res, {
			'status is 2xx success': (r) => r.status >= 200 && r.status < 300,
			'has orderId': () => body.orderId !== undefined,
			'success is true': () => body.success === true,
		})

		if (success) {
			console.log(`\n🎉 VU ${vuId} (${user.username}) WON the flash sale!`)
			console.log(`   Order ID: ${body.orderId}`)
			seckillSuccess.add(1)
			seckillSuccessRate.add(1)
		}
	} else if (res.status === 409 || body.error === 'OUT_OF_STOCK') {
		// Out of stock - someone else got it
		console.log(`\n😢 VU ${vuId} (${user.username}) - OUT OF STOCK`)
		seckillOutOfStock.add(1)
		seckillSuccessRate.add(0)
		
		check(res, {
			'out of stock response': () => body.error === 'OUT_OF_STOCK',
		})
	} else if (body.error === 'ALREADY_PURCHASED') {
		// Duplicate purchase attempt
		console.log(`\n⚠️  VU ${vuId} (${user.username}) - Already purchased`)
		seckillDuplicate.add(1)
		seckillSuccessRate.add(0)
	} else if (body.error === 'RATE_LIMIT_EXCEEDED') {
		// Rate limited
		console.log(`\n⏳ VU ${vuId} (${user.username}) - Rate limited`)
		seckillErrors.add(1)
		seckillSuccessRate.add(0)
	} else {
		// Unexpected error
		console.error(`\n❌ VU ${vuId} (${user.username}) - Unexpected response:`)
		console.error(`   Status: ${res.status}`)
		console.error(`   Body: ${res.body}`)
		seckillErrors.add(1)
		seckillSuccessRate.add(0)
	}
}

/**
 * Teardown: Verify final state
 */
export function teardown(data) {
	const { productId } = data

	console.log(`\n\n========================================`)
	console.log(`📊 FINAL RESULTS`)
	console.log(`========================================`)

	// Check final campaign status
	const statusRes = http.get(`${BASE_URL}/seckill/status/${productId}`)
	
	if (statusRes.status === 200) {
		const status = JSON.parse(statusRes.body)
		console.log(`\n📦 Campaign Status:`)
		console.log(`   Product: ${productId}`)
		console.log(`   Stock Remaining: ${status.stockRemaining}`)
		console.log(`   Total Stock: ${status.totalStock}`)
		console.log(`   Is Active: ${status.isActive}`)

		// Verify stock is 0 (1 person bought it)
		if (status.stockRemaining === 0) {
			console.log(`\n✅ TEST PASSED: Stock depleted correctly (1 buyer won)`)
		} else {
			console.log(`\n⚠️  WARNING: Stock remaining = ${status.stockRemaining} (expected 0)`)
		}
	} else {
		console.log(`\n⚠️  Could not fetch final status: ${statusRes.status}`)
	}

	console.log(`\n========================================`)
	console.log(`Expected Results:`)
	console.log(`  - seckill_success: 1 (one winner)`)
	console.log(`  - seckill_out_of_stock: 1 (one loser)`)
	console.log(`  - seckill_errors: 0`)
	console.log(`========================================\n`)
}
