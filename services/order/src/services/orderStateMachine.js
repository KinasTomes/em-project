const StateMachine = require('javascript-state-machine')
const logger = require('@ecommerce/logger')

/**
 * Order State Machine
 * 
 * Valid transitions:
 * - PENDING → CONFIRMED (when all inventory reserved)
 * - PENDING → PAID (when payment succeeded directly)
 * - PENDING → CANCELLED (when inventory reserve failed or payment failed)
 * 
 * Final states: CONFIRMED, PAID, CANCELLED (cannot transition from these)
 */
class OrderStateMachine {
	constructor(initialState = 'PENDING') {
		this.fsm = StateMachine.create({
			initial: initialState,
			events: [
				{ name: 'confirm', from: 'PENDING', to: 'CONFIRMED' },
				{ name: 'pay', from: 'PENDING', to: 'PAID' },
				{ name: 'cancel', from: 'PENDING', to: 'CANCELLED' },
			],
			callbacks: {
				onenterstate: (lifecycle, from, to) => {
					logger.debug(
						{ from, to },
						'[OrderStateMachine] State transition'
					)
				},
				oninvalidtransition: (lifecycle, transition, from, to) => {
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
		return this.fsm.current
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
		const finalStates = ['CONFIRMED', 'PAID', 'CANCELLED']
		return finalStates.includes(this.fsm.current)
	}

	/**
	 * Transition to CONFIRMED (when all inventory reserved)
	 */
	confirm() {
		if (!this.can('confirm')) {
			throw new Error(
				`Cannot confirm order from state: ${this.fsm.current}`
			)
		}
		this.fsm.confirm()
		return this.fsm.current
	}

	/**
	 * Transition to PAID (when payment succeeded)
	 */
	pay() {
		if (!this.can('pay')) {
			throw new Error(
				`Cannot pay order from state: ${this.fsm.current}`
			)
		}
		this.fsm.pay()
		return this.fsm.current
	}

	/**
	 * Transition to CANCELLED (when inventory reserve failed or payment failed)
	 */
	cancel() {
		if (!this.can('cancel')) {
			throw new Error(
				`Cannot cancel order from state: ${this.fsm.current}`
			)
		}
		this.fsm.cancel()
		return this.fsm.current
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

