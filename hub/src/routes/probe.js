'use strict';
/**
 * routes/probe.js — /api/probe endpoint
 *
 * GET /api/probe?magnet=...&safari=0&canHevc=1&canH264=1&canVP9=0&canAV1=0&canMkv=1
 *
 * Fast path: parse codec/container from magnet dn= filename — zero network calls.
 * Slow path: fetch /info from streamer when no dn= is available.
 */

const express = require('express');
const axios = require('axios');
const config = require('../config');
const { parseMagnetDn, determineDirectPlay } = require('../probe');
const { makeLogger } = require('../logger');

const log = makeLogger('Probe');
const router = express.Router();

router.get('/', async (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    const caps = {
        isSafari: req.query.safari === '1',
        canHevc: req.query.canHevc === '1',
        canH264: req.query.canH264 !== '0',   // default true
        canVP9: req.query.canVP9 === '1',
        canAV1: req.query.canAV1 === '1',
        canMkv: req.query.canMkv !== '0',   // default true (desktop)
    };

    // ── Fast path: parse filename from dn= ────────────────────────────────────
    const dnInfo = parseMagnetDn(magnetURI);
    if (dnInfo) {
        // Warm up the streamer in the background — client can keep going
        axios.get(`${config.streamerUrl}/info?magnet=${encodeURIComponent(magnetURI)}`, {
            timeout: 15_000,
        }).catch(() => { });

        const { canDirectPlay, codec } = determineDirectPlay(dnInfo, caps);
        log.info(`Fast probe: ${dnInfo.name} | safari:${caps.isSafari} → ${canDirectPlay ? 'Direct' : 'Transcode(' + codec + ')'}`);

        return res.json({
            status: 'ready',
            canDirectPlay,
            codec: canDirectPlay ? 'h264' : codec,
            container: dnInfo.extension,
            resolution: 'unknown',
            fileName: dnInfo.name,
            fileSize: 0,
        });
    }

    // ── Slow path: ask streamer for file info ─────────────────────────────────
    log.info(`Slow probe (no dn=): ${magnetURI.substring(0, 60)}`);
    try {
        const r = await axios.get(`${config.streamerUrl}/info?magnet=${encodeURIComponent(magnetURI)}`, {
            timeout: 60_000,
        });
        const fileInfo = r.data;
        const { canDirectPlay, codec } = determineDirectPlay(fileInfo, caps);
        log.info(`Slow probe result: ${fileInfo.name} → ${canDirectPlay ? 'Direct' : 'Transcode(' + codec + ')'}`);

        return res.json({
            status: 'ready',
            canDirectPlay,
            codec: canDirectPlay ? 'h264' : codec,
            container: fileInfo.extension,
            resolution: 'unknown',
            fileName: fileInfo.name,
            fileSize: fileInfo.size,
        });
    } catch (_) {
        return res.json({ status: 'pending', message: 'Fetching torrent metadata...' });
    }
});

module.exports = router;
