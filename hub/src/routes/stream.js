'use strict';
/**
 * routes/stream.js — /api/stream transparent proxy to Streamer
 *
 * All range requests, headers, and the response body are forwarded verbatim.
 */

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const config = require('../config');

const router = express.Router();

router.use(
    '/',
    createProxyMiddleware({
        target: config.streamerUrl,
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        pathRewrite: { '^/api/stream': '/stream' },
        on: {
            proxyRes(proxyRes) {
                proxyRes.headers['Access-Control-Allow-Origin'] = '*';
            },
            error(err, req, res) {
                if (!res.headersSent) res.status(502).send('Stream proxy error: ' + err.message);
            },
        },
    })
);

module.exports = router;
