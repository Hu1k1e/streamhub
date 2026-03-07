'use strict';
/**
 * routes/status.js — Status and utility endpoints
 *
 * GET /api/status?magnet=... — torrent download status (proxied to streamer)
 * GET /api/stream-url        — returns the streamer URL (for client debug)
 */

const express = require('express');
const axios = require('axios');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('Status');
const router = express.Router();

router.get('/stream-url', (req, res) => {
    res.json({ url: config.streamerUrl });
});

router.get('/status', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });
    try {
        const r = await axios.get(`${config.streamerUrl}/status`, {
            params: { magnet },
            timeout: 5000,
        });
        res.json(r.data);
    } catch (e) {
        log.warn(`Status fetch failed: ${e.message}`);
        res.status(500).json({ error: 'Status fetch failed' });
    }
});

module.exports = router;
