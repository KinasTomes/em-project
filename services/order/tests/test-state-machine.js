// Quick test to verify OrderStateMachine works correctly
const { createOrderStateMachine } = require('./src/services/orderStateMachine')

console.log('Testing OrderStateMachine...\n')

try {
	// Test 1: PENDING → CONFIRMED
	console.log('Test 1: PENDING → CONFIRMED')
	const fsm1 = createOrderStateMachine('PENDING')
	console.log('  Initial state:', fsm1.getState())
	console.log('  Can confirm?', fsm1.can('confirm'))
	fsm1.confirm()
	console.log('  After confirm:', fsm1.getState())
	console.log('  ✅ PASS\n')

	// Test 2: CONFIRMED → PAID
	console.log('Test 2: CONFIRMED → PAID')
	const fsm2 = createOrderStateMachine('CONFIRMED')
	console.log('  Initial state:', fsm2.getState())
	console.log('  Can pay?', fsm2.can('pay'))
	fsm2.pay()
	console.log('  After pay:', fsm2.getState())
	console.log('  Is final state?', fsm2.isFinalState())
	console.log('  ✅ PASS\n')

	// Test 3: PENDING → CANCELLED
	console.log('Test 3: PENDING → CANCELLED')
	const fsm3 = createOrderStateMachine('PENDING')
	console.log('  Initial state:', fsm3.getState())
	console.log('  Can cancel?', fsm3.can('cancel'))
	fsm3.cancel()
	console.log('  After cancel:', fsm3.getState())
	console.log('  Is final state?', fsm3.isFinalState())
	console.log('  ✅ PASS\n')

	// Test 4: CONFIRMED → CANCELLED (payment failed)
	console.log('Test 4: CONFIRMED → CANCELLED (payment failed)')
	const fsm4 = createOrderStateMachine('CONFIRMED')
	console.log('  Initial state:', fsm4.getState())
	console.log('  Can cancel?', fsm4.can('cancel'))
	fsm4.cancel()
	console.log('  After cancel:', fsm4.getState())
	console.log('  ✅ PASS\n')

	// Test 5: Invalid transition PENDING → PAID (should fail)
	console.log('Test 5: Invalid transition PENDING → PAID (should fail)')
	const fsm5 = createOrderStateMachine('PENDING')
	console.log('  Initial state:', fsm5.getState())
	console.log('  Can pay?', fsm5.can('pay'))
	try {
		fsm5.pay()
		console.log('  ❌ FAIL: Should have thrown error\n')
	} catch (error) {
		console.log('  Expected error:', error.message)
		console.log('  ✅ PASS\n')
	}

	// Test 6: Cannot transition from final state
	console.log('Test 6: Cannot transition from final state PAID')
	const fsm6 = createOrderStateMachine('PAID')
	console.log('  Initial state:', fsm6.getState())
	console.log('  Is final state?', fsm6.isFinalState())
	console.log('  Can confirm?', fsm6.can('confirm'))
	console.log('  Can pay?', fsm6.can('pay'))
	console.log('  Can cancel?', fsm6.can('cancel'))
	console.log('  ✅ PASS\n')

	console.log('✅ All tests passed!')
	process.exit(0)
} catch (error) {
	console.error('❌ Test failed:', error.message)
	console.error(error.stack)
	process.exit(1)
}
