const express = require('express')

function createHealthRouter() {
	const router = express.Router()

	router.get('/live', (_req, res) => {
		res.status(200).json({ status: 'ok', service: 'payment', live: true })
	})

	router.get('/ready', (_req, res) => {
		res.status(200).json({ status: 'ok', service: 'payment', ready: true })
	})

	return router
}

module.exports = createHealthRouter

