const StateMachine = require('javascript-state-machine')
const logger = require('@ecommerce/logger')

/**
 * Order State Machine
 * 
 * Valid transitions:
 * - PENDING → CONFIRMED (when all inventory reserved)
 * - PENDING → CANCELLED (when inventory reserve failed)
 * - CONFIRMED → PAID (when payment succeeded)
 * - CONFIRMED → CANCELLED (when payment failed)
 * 
 * Flow: PENDING → CONFIRMED → PAID (happy path)
 *       PENDING → CANCELLED (inventory failed)
 *       CONFIRMED → CANCELLED (payment failed)
 * 
 * Rules:
 * - Order MUST be CONFIRMED before it can be PAID
 * - Cannot transition directly from PENDING → PAID
 * - Final states: PAID, CANCELLED (cannot transition from these)
 */
class OrderStateMachine {
	constructor(initialState = 'PENDING') {
		this.fsm = new StateMachine({
			init: initialState,
			transitions: [
				{ name: 'confirm', from: 'PENDING', to: 'CONFIRMED' },
				{ name: 'pay', from: 'CONFIRMED', to: 'PAID' },
				{ name: 'cancel', from: ['PENDING', 'CONFIRMED'], to: 'CANCELLED' },
			],
			methods: {
				onEnterState: (lifecycle) => {
					logger.debug(
						{ from: lifecycle.from, to: lifecycle.to },
						'[OrderStateMachine] State transition'
					)
				},
				onInvalidTransition: (transition, from, to) => {
					logger.warn(
						{ transition, from, to },
						'[OrderStateMachine] Invalid transition attempted'
					)
					throw new Error(
						`Invalid transition: Cannot ${transition} from ${from} to ${to}`
					)
				},
			},
		})
	}

	/**
	 * Get current state
	 */
	getState() {
		return this.fsm.state
	}

	/**
	 * Check if transition is allowed
	 */
	can(transition) {
		return this.fsm.can(transition)
	}

	/**
	 * Check if current state is final state
	 */
	isFinalState() {
		const finalStates = ['PAID', 'CANCELLED']
		return finalStates.includes(this.fsm.state)
	}

	/**
	 * Transition to CONFIRMED (when all inventory reserved)
	 * Idempotent: returns success if already CONFIRMED
	 */
	confirm() {
		// Already in target state - idempotent success
		if (this.fsm.state === 'CONFIRMED') {
			logger.debug('[OrderStateMachine] Order already CONFIRMED, skipping transition')
			return this.fsm.state
		}
		if (!this.can('confirm')) {
			throw new Error(
				`Cannot confirm order from state: ${this.fsm.state}`
			)
		}
		this.fsm.confirm()
		return this.fsm.state
	}

	/**
	 * Transition to PAID (when payment succeeded)
	 * Can ONLY transition from CONFIRMED state
	 * Order must be confirmed (inventory reserved) before payment
	 * Idempotent: returns success if already PAID
	 */
	pay() {
		// Already in target state - idempotent success
		if (this.fsm.state === 'PAID') {
			logger.debug('[OrderStateMachine] Order already PAID, skipping transition')
			return this.fsm.state
		}
		if (!this.can('pay')) {
			throw new Error(
				`Cannot pay order from state: ${this.fsm.state}. Order must be CONFIRMED before payment.`
			)
		}
		this.fsm.pay()
		return this.fsm.state
	}

	/**
	 * Transition to CANCELLED
	 * Can transition from PENDING (inventory reserve failed) or CONFIRMED (payment failed)
	 * Idempotent: returns success if already CANCELLED
	 */
	cancel() {
		// Already in target state - idempotent success
		if (this.fsm.state === 'CANCELLED') {
			logger.debug('[OrderStateMachine] Order already CANCELLED, skipping transition')
			return this.fsm.state
		}
		if (!this.can('cancel')) {
			throw new Error(
				`Cannot cancel order from state: ${this.fsm.state}. Allowed from: PENDING, CONFIRMED`
			)
		}
		this.fsm.cancel()
		return this.fsm.state
	}
}

/**
 * Create state machine instance from order status
 */
function createOrderStateMachine(currentStatus) {
	return new OrderStateMachine(currentStatus)
}

/**
 * Validate if transition is allowed for an order
 */
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

module.exports = {
	OrderStateMachine,
	createOrderStateMachine,
	canTransition,
}

