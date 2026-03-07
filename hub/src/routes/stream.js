'use strict';
/**
 * routes/stream.js — /api/stream transparent proxy to Streamer
 *
 * IMPORTANT: This router is mounted at app.use('/api/stream', ...).
 * Express strips the mount path before the router sees it.
 * So pathRewrite must rewrite from '^/' (not '^/api/stream').
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
        proxyTimeout: 0,    // no timeout — long-lived streaming responses
        timeout: 0,
        pathRewrite: { '^/': '/stream' }, // Express strips /api/stream — rewrite '/' → '/stream'
        selfHandleResponse: false,        // let proxy stream the response directly
        on: {
            proxyReq(proxyReq, req) {
                // Forward Range header verbatim — browser sends this for video seeks
                if (req.headers.range) {
                    proxyReq.setHeader('Range', req.headers.range);
                }
            },
            proxyRes(proxyRes, req, res) {
                // Expose CORS so the browser's video element can read headers
                proxyRes.headers['Access-Control-Allow-Origin'] = '*';
                // Log response status for debugging
                const range = req.headers.range || 'none';
                console.log(`[Stream Proxy] ${proxyRes.statusCode} | Range: ${range}`);
            },
            error(err, req, res) {
                console.error('[Stream Proxy] Error:', err.message);
                if (!res.headersSent) res.status(502).send('Stream proxy error: ' + err.message);
            },
        },
    })
);

module.exports = router;
