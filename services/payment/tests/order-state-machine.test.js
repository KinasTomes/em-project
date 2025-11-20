const { describe, it, beforeEach } = require('mocha')
const { expect } = require('chai')
const StateMachine = require('javascript-state-machine')

/**
 * Tests for Order State Machine
 * 
 * Flow rules:
 * - PENDING → CONFIRMED (inventory reserved)
 * - PENDING → CANCELLED (inventory reserve failed)
 * - CONFIRMED → PAID (payment succeeded)
 * - CONFIRMED → CANCELLED (payment failed)
 * - Cannot transition PENDING → PAID directly
 */
// Helper function to create state machine (same as in order service)
function createOrderStateMachine(initialState = 'PENDING') {
	const fsm = StateMachine.create({
		initial: initialState,
		events: [
			{ name: 'confirm', from: 'PENDING', to: 'CONFIRMED' },
			{ name: 'pay', from: 'CONFIRMED', to: 'PAID' },
			{ name: 'cancel', from: ['PENDING', 'CONFIRMED'], to: 'CANCELLED' },
		],
	})
	return {
		can: (transition) => fsm.can(transition),
		getState: () => fsm.current,
		confirm: () => fsm.confirm(),
		pay: () => fsm.pay(),
		cancel: () => fsm.cancel(),
		isFinalState: () => {
			const finalStates = ['PAID', 'CANCELLED']
			return finalStates.includes(fsm.current)
		},
	}
}

function canTransition(order, targetStatus) {
	const fsm = createOrderStateMachine(order.status)
	switch (targetStatus) {
		case 'CONFIRMED':
			return fsm.can('confirm')
		case 'PAID':
			return fsm.can('pay')
		case 'CANCELLED':
			return fsm.can('cancel')
		default:
			return false
	}
}

describe('Order State Machine Tests', () => {
	describe('Valid Transitions', () => {
		it('should allow PENDING → CONFIRMED transition', () => {
			const fsm = createOrderStateMachine('PENDING')
			expect(fsm.can('confirm')).to.be.true
			
			fsm.confirm()
			expect(fsm.getState()).to.equal('CONFIRMED')
		})

		it('should allow PENDING → CANCELLED transition (inventory failed)', () => {
			const fsm = createOrderStateMachine('PENDING')
			expect(fsm.can('cancel')).to.be.true
			
			fsm.cancel()
			expect(fsm.getState()).to.equal('CANCELLED')
		})

		it('should allow CONFIRMED → PAID transition (payment succeeded)', () => {
			const fsm = createOrderStateMachine('CONFIRMED')
			expect(fsm.can('pay')).to.be.true
			
			fsm.pay()
			expect(fsm.getState()).to.equal('PAID')
		})

		it('should allow CONFIRMED → CANCELLED transition (payment failed)', () => {
			const fsm = createOrderStateMachine('CONFIRMED')
			expect(fsm.can('cancel')).to.be.true
			
			fsm.cancel()
			expect(fsm.getState()).to.equal('CANCELLED')
		})
	})

	describe('Invalid Transitions', () => {
		it('should NOT allow PENDING → PAID transition', () => {
			const fsm = createOrderStateMachine('PENDING')
			expect(fsm.can('pay')).to.be.false
			
			expect(() => fsm.pay()).to.throw()
		})

		it('should NOT allow CONFIRMED → CONFIRMED transition', () => {
			const fsm = createOrderStateMachine('CONFIRMED')
			expect(fsm.can('confirm')).to.be.false
		})

		it('should NOT allow PAID → CANCELLED transition (final state)', () => {
			const fsm = createOrderStateMachine('PAID')
			expect(fsm.can('cancel')).to.be.false
			expect(fsm.isFinalState()).to.be.true
		})

		it('should NOT allow CANCELLED → PAID transition (final state)', () => {
			const fsm = createOrderStateMachine('CANCELLED')
			expect(fsm.can('pay')).to.be.false
			expect(fsm.isFinalState()).to.be.true
		})

		it('should NOT allow PAID → CONFIRMED transition', () => {
			const fsm = createOrderStateMachine('PAID')
			expect(fsm.can('confirm')).to.be.false
		})
	})

	describe('Complete Flow: Happy Path', () => {
		it('should handle flow: PENDING → CONFIRMED → PAID', () => {
			// Step 1: PENDING → CONFIRMED (inventory reserved)
			const fsm1 = createOrderStateMachine('PENDING')
			expect(fsm1.can('confirm')).to.be.true
			fsm1.confirm()
			expect(fsm1.getState()).to.equal('CONFIRMED')
			expect(fsm1.isFinalState()).to.be.false

			// Step 2: CONFIRMED → PAID (payment succeeded)
			const fsm2 = createOrderStateMachine('CONFIRMED')
			expect(fsm2.can('pay')).to.be.true
			fsm2.pay()
			expect(fsm2.getState()).to.equal('PAID')
			expect(fsm2.isFinalState()).to.be.true
		})
	})

	describe('Complete Flow: Inventory Failed', () => {
		it('should handle flow: PENDING → CANCELLED (inventory reserve failed)', () => {
			const fsm = createOrderStateMachine('PENDING')
			expect(fsm.can('cancel')).to.be.true
			fsm.cancel()
			expect(fsm.getState()).to.equal('CANCELLED')
			expect(fsm.isFinalState()).to.be.true
		})
	})

	describe('Complete Flow: Payment Failed', () => {
		it('should handle flow: PENDING → CONFIRMED → CANCELLED (payment failed)', () => {
			// Step 1: PENDING → CONFIRMED (inventory reserved)
			const fsm1 = createOrderStateMachine('PENDING')
			fsm1.confirm()
			expect(fsm1.getState()).to.equal('CONFIRMED')

			// Step 2: CONFIRMED → CANCELLED (payment failed)
			const fsm2 = createOrderStateMachine('CONFIRMED')
			expect(fsm2.can('cancel')).to.be.true
			fsm2.cancel()
			expect(fsm2.getState()).to.equal('CANCELLED')
			expect(fsm2.isFinalState()).to.be.true
		})
	})

	describe('State Machine Operations', () => {
		it('should transition PENDING → CONFIRMED', () => {
			const fsm = createOrderStateMachine('PENDING')
			fsm.confirm()
			expect(fsm.getState()).to.equal('CONFIRMED')
		})

		it('should transition CONFIRMED → PAID', () => {
			const fsm = createOrderStateMachine('CONFIRMED')
			fsm.pay()
			expect(fsm.getState()).to.equal('PAID')
		})

		it('should transition PENDING → CANCELLED', () => {
			const fsm = createOrderStateMachine('PENDING')
			fsm.cancel()
			expect(fsm.getState()).to.equal('CANCELLED')
		})

		it('should transition CONFIRMED → CANCELLED', () => {
			const fsm = createOrderStateMachine('CONFIRMED')
			fsm.cancel()
			expect(fsm.getState()).to.equal('CANCELLED')
		})

		it('should throw error on invalid PENDING → PAID transition', () => {
			const fsm = createOrderStateMachine('PENDING')
			expect(() => fsm.pay()).to.throw()
		})
	})

	describe('Final States', () => {
		it('should identify PAID as final state', () => {
			const fsm = createOrderStateMachine('PAID')
			expect(fsm.isFinalState()).to.be.true
		})

		it('should identify CANCELLED as final state', () => {
			const fsm = createOrderStateMachine('CANCELLED')
			expect(fsm.isFinalState()).to.be.true
		})

		it('should NOT identify CONFIRMED as final state', () => {
			const fsm = createOrderStateMachine('CONFIRMED')
			expect(fsm.isFinalState()).to.be.false
		})

		it('should NOT identify PENDING as final state', () => {
			const fsm = createOrderStateMachine('PENDING')
			expect(fsm.isFinalState()).to.be.false
		})
	})

	describe('canTransition Helper', () => {
		it('should return true for valid PENDING → CONFIRMED', () => {
			const order = { status: 'PENDING' }
			expect(canTransition(order, 'CONFIRMED')).to.be.true
		})

		it('should return true for valid CONFIRMED → PAID', () => {
			const order = { status: 'CONFIRMED' }
			expect(canTransition(order, 'PAID')).to.be.true
		})

		it('should return true for valid PENDING → CANCELLED', () => {
			const order = { status: 'PENDING' }
			expect(canTransition(order, 'CANCELLED')).to.be.true
		})

		it('should return true for valid CONFIRMED → CANCELLED', () => {
			const order = { status: 'CONFIRMED' }
			expect(canTransition(order, 'CANCELLED')).to.be.true
		})

		it('should return false for invalid PENDING → PAID', () => {
			const order = { status: 'PENDING' }
			expect(canTransition(order, 'PAID')).to.be.false
		})

		it('should return false for invalid PAID → CANCELLED', () => {
			const order = { status: 'PAID' }
			expect(canTransition(order, 'CANCELLED')).to.be.false
		})
	})

	describe('Payment Flow State Transitions', () => {
		it('should handle complete happy path: PENDING → CONFIRMED → PAID', () => {
			// Step 1: PENDING → CONFIRMED (inventory reserved)
			const fsm1 = createOrderStateMachine('PENDING')
			fsm1.confirm()
			expect(fsm1.getState()).to.equal('CONFIRMED')

			// Step 2: CONFIRMED → PAID (payment succeeded)
			const fsm2 = createOrderStateMachine('CONFIRMED')
			fsm2.pay()
			expect(fsm2.getState()).to.equal('PAID')
		})

		it('should NOT allow direct PENDING → PAID (must go through CONFIRMED)', () => {
			const fsm = createOrderStateMachine('PENDING')
			expect(fsm.can('pay')).to.be.false
			expect(() => fsm.pay()).to.throw()
		})

		it('should handle payment failure: CONFIRMED → CANCELLED', () => {
			const fsm = createOrderStateMachine('CONFIRMED')
			fsm.cancel()
			expect(fsm.getState()).to.equal('CANCELLED')
		})

		it('should handle inventory failure: PENDING → CANCELLED', () => {
			const fsm = createOrderStateMachine('PENDING')
			fsm.cancel()
			expect(fsm.getState()).to.equal('CANCELLED')
		})
	})

	describe('Edge Cases', () => {
		it('should not allow transitions from final states', () => {
			const paidFsm = createOrderStateMachine('PAID')
			expect(paidFsm.can('pay')).to.be.false
			expect(paidFsm.can('confirm')).to.be.false
			expect(paidFsm.can('cancel')).to.be.false

			const cancelledFsm = createOrderStateMachine('CANCELLED')
			expect(cancelledFsm.can('pay')).to.be.false
			expect(cancelledFsm.can('confirm')).to.be.false
			expect(cancelledFsm.can('cancel')).to.be.false
		})

		it('should allow multiple cancellation paths', () => {
			// Can cancel from PENDING (inventory failed)
			const fsm1 = createOrderStateMachine('PENDING')
			expect(fsm1.can('cancel')).to.be.true

			// Can cancel from CONFIRMED (payment failed)
			const fsm2 = createOrderStateMachine('CONFIRMED')
			expect(fsm2.can('cancel')).to.be.true
		})
	})
})
