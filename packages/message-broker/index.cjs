// CommonJS wrapper for @ecommerce/message-broker
let messageModule

async function loadModule() {
	if (!messageModule) {
		messageModule = await import('./index.js')
	}
	return messageModule
}

// Export Broker class as CommonJS
class Broker {
	constructor() {
		this._brokerPromise = loadModule().then((mod) => {
			this._broker = new mod.Broker()
			return this._broker
		})
	}

	async _ensureBroker() {
		if (!this._broker) {
			await this._brokerPromise
		}
		return this._broker
	}

	async publish(queueName, message, metadata) {
		const broker = await this._ensureBroker()
		return broker.publish(queueName, message, metadata)
	}

	async consume(queueName, handler, options) {
		const broker = await this._ensureBroker()
		return broker.consume(queueName, handler, options)
	}

	async close() {
		if (this._broker) {
			return this._broker.close()
		}
	}

	// Proxy other properties when accessed
	get connection() {
		return this._broker?.connection
	}

	get channel() {
		return this._broker?.channel
	}

	get isConnected() {
		return this._broker?.isConnected || false
	}
}

module.exports = { Broker }
