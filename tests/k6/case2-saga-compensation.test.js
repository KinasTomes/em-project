/**
 * k6 Load Test: Case 2 - Saga Compensation (Event-Driven Saga)
 *
 * Mục tiêu: Kiểm chứng cơ chế Compensation hoạt động khi có lỗi xảy ra.
 * - Scenario: Payment Service có tỷ lệ fail 10% (do config PAYMENT_SUCCESS_RATE=0.9).
 * - Expectation: Khi Payment fail, Inventory phải được rollback -> Order status = CANCELLED.
 *
 * Chỉ số đo lường:
 * - saga_duration: Thời gian từ khi tạo đơn đến khi transaction hoàn tất (PAID hoặc CANCELLED).
 * - saga_compensation_rate: Tỷ lệ đơn hàng được compensate thành công khi lỗi.
 * - final_status_distribution: Phân bố trạng thái cuối cùng (PAID vs CANCELLED).
 *
 * Cách chạy:
 *   k6 run --env API_BASE=http://<VM_IP>:3003 tests/k6/case2-saga-compensation.test.js
 */

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Trend, Counter, Rate } from 'k6/metrics'

// Helper function to generate random string locally
function randomString(length) {
    const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let res = '';
    while (length--) res += charset[Math.random() * charset.length | 0];
    return res;
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const API_BASE = __ENV.API_BASE || 'http://136.110.42.41:3003'
const POLL_INTERVAL = 0.5 // Poll every 500ms
const MAX_POLLS = 20 // Max wait 10s for saga to finish

// ============================================================================
// CUSTOM METRICS
// ============================================================================
const sagaDuration = new Trend('saga_duration', true)
const compensationCounter = new Counter('saga_compensations_total')
const successCounter = new Counter('saga_success_total')
const failedCounter = new Counter('saga_failed_unrecovered_total')

// ============================================================================
// TEST OPTIONS
// ============================================================================
export const options = {
    scenarios: {
        compensation_test: {
            executor: 'constant-vus',
            vus: 10,
            duration: '30s', // Chạy 30s để thu thập đủ mẫu
        },
    },
    thresholds: {
        saga_duration: ['p(95)<5000'], // Saga nên hoàn tất trong 5s
    },
}

// ============================================================================
// SETUP
// ============================================================================
export function setup() {
    console.log(`\n🚀 Starting Case 2 Test - Saga Compensation`)
    console.log(`📍 API Base: ${API_BASE}`)
    console.log(`ℹ️  Note: Ensure PAYMENT_SUCCESS_RATE < 1.0 (e.g. 0.9) in .env to see compensations.\n`)

    // 1. Register test user
    const username = `saga_test_${randomString(8)}`
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
        throw new Error(`Setup failed: Register returned ${registerRes.status}`)
    }

    sleep(0.5)

    // 2. Login
    const loginRes = http.post(
        `${API_BASE}/auth/login`,
        JSON.stringify({
            username: username,
            password: password,
        }),
        { headers: { 'Content-Type': 'application/json' } }
    )

    const loginData = JSON.parse(loginRes.body)
    if (!loginData.token) {
        throw new Error(`Setup failed: Login returned ${loginRes.status}`)
    }
    const token = loginData.token

    // 3. Get/Create Product
    let productId = null
    const productsRes = http.get(`${API_BASE}/products?limit=1`, {
        headers: { Authorization: `Bearer ${token}` }
    })

    try {
        const body = JSON.parse(productsRes.body)
        const products = body.data || body
        if (products && products.length > 0) {
            productId = products[0]._id || products[0].id
        }
    } catch (e) {
        console.error("Failed to parse products")
    }

    if (!productId) {
        console.log("Creating new product for test...")
        const createP = http.post(`${API_BASE}/products`, JSON.stringify({
            name: `Saga Prod ${randomString(5)}`,
            price: 100,
            stock: 10000
        }), {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        })
        const pBody = JSON.parse(createP.body)
        productId = pBody._id || pBody.id
    }

    return { token, productId }
}

// ============================================================================
// MAIN TEST
// ============================================================================
export default function (data) {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.token}`,
    }

    // 1. Create Order
    const start = Date.now()
    const orderRes = http.post(`${API_BASE}/orders`, JSON.stringify({
        ids: [data.productId],
        quantities: [1]
    }), { headers: headers })

    if (orderRes.status >= 400) {
        failedCounter.add(1)
        return
    }

    const orderBody = JSON.parse(orderRes.body)
    const orderId = orderBody._id || orderBody.id || orderBody.orderId

    // 2. Poll for final status (Saga settlement)
    let finalStatus = 'PENDING'
    let polls = 0

    while (polls < MAX_POLLS) {
        sleep(POLL_INTERVAL)
        polls++

        const checkRes = http.get(`${API_BASE}/orders/${orderId}`, { headers: headers })
        if (checkRes.status === 200) {
            const order = JSON.parse(checkRes.body)
            const status = order.status

            // Trạng thái cuối cùng mong đợi
            if (status === 'PAID' || status === 'CANCELLED') {
                finalStatus = status
                break
            }
        }
    }

    const duration = Date.now() - start
    sagaDuration.add(duration)

    // 3. Classification
    if (finalStatus === 'PAID') {
        successCounter.add(1)
    } else if (finalStatus === 'CANCELLED') {
        // Đây chính là Compensation thành công!
        // Payment fail -> Inventory rollback -> Cancelled
        compensationCounter.add(1)
    } else {
        // Vẫn PENDING sau timeout -> Saga stuck (Lỗi)
        failedCounter.add(1)
    }
}

// ============================================================================
// CUSTOM SUMMARY
// ============================================================================
export function handleSummary(data) {
    const total = data.metrics.iterations.values.count
    const success = data.metrics.saga_success_total.values.count
    const compensated = data.metrics.saga_compensations_total.values.count
    const failed = data.metrics.saga_failed_unrecovered_total.values.count
    const avgDur = data.metrics.saga_duration.values.avg.toFixed(0)

    console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║                    CASE 2: SAGA COMPENSATION TEST                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║ Total Transactions     │ ${String(total).padEnd(20)}                      ║
╠════════════════════════╪═════════════════════════════════════════════════╣
║ ✅ Paid (Success)      │ ${String(success).padEnd(5)} (${((success / total) * 100).toFixed(1)}%)                             ║
║ ↩️  Compensated        │ ${String(compensated).padEnd(5)} (${((compensated / total) * 100).toFixed(1)}%) - Payment Failed -> Rolled back ║
║ ❌ Stuck/Failed        │ ${String(failed).padEnd(5)} (${((failed / total) * 100).toFixed(1)}%)                             ║
╠════════════════════════╪═════════════════════════════════════════════════╣
║ Avg Settlement Time    │ ${avgDur} ms                                       ║
╚══════════════════════════════════════════════════════════════════════════╝
    `)

    return {
        stdout: JSON.stringify(data, null, 2),
    }
}
