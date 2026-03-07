'use strict';
/**
 * routes/hls.js — HLS session endpoints
 *
 * POST /api/hls/start          — create session, start FFmpeg, wait for readiness
 * POST /api/hls/seek/:id       — seek to new position (kill+restart FFmpeg)
 * POST /api/hls/stop/:id       — stop FFmpeg, schedule 5-min cleanup
 * GET  /api/hls/status/:id     — session status
 * GET  /api/hls/:id/index.m3u8 — serve playlist
 * GET  /api/hls/:id/:segment   — serve .ts segment (long-polls until available)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const hls = require('../hlsManager');
const { makeLogger } = require('../logger');
const { parseMagnetDn } = require('../probe');

const log = makeLogger('HLS-Route');
const router = express.Router();

// ── POST /api/hls/start ──────────────────────────────────────────────────────
router.post('/start', async (req, res) => {
    const { magnet, codec, resolution } = req.body;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

    const rawStreamUrl = `${config.streamerUrl}/stream?magnet=${encodeURIComponent(magnet)}`;

    // Warm up streamer: call /info which waits for torrent metadata to be ready.
    // We capture the response to avoid a separate ffprobe on the live /stream URL
    // (probing /stream takes 12s+ to start and returns 0 duration, breaking HLS).
    log.info(`Warming up streamer for: ${(parseMagnetDn(magnet) || {}).name || magnet.substring(0, 60)}`);
    const axios = require('axios');
    let warmedUp = false;
    let infoData = null;
    let delay = config.streamerWarmupRetryBase;
    const deadline = Date.now() + config.streamerWarmupTimeoutMs;

    for (let i = 0; i < config.streamerWarmupMaxRetries; i++) {
        try {
            const resp = await axios.get(`${config.streamerUrl}/info?magnet=${encodeURIComponent(magnet)}`, {
                timeout: 30_000,
            });
            infoData = resp.data;
            log.info(`Streamer warmup OK (attempt ${i + 1}) — file: ${infoData.name || '?'} size: ${(infoData.size / 1e9).toFixed(2)} GB`);
            warmedUp = true;
            break;
        } catch (err) {
            if (Date.now() >= deadline) {
                log.warn(`Streamer warmup deadline exceeded — proceeding anyway`);
                break;
            }
            log.warn(`Streamer warmup attempt ${i + 1} failed (${err.message}) — retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 2, 10_000);
        }
    }

    if (!warmedUp) {
        log.warn('Streamer never confirmed ready — FFmpeg may fail if torrent is still loading');
    }

    try {
        const result = await hls.createSession(
            { magnet, codec, resolution, infoData },
            rawStreamUrl,
        );
        return res.json(result);
    } catch (err) {
        log.error(`createSession failed: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/hls/seek/:sessionId ────────────────────────────────────────────
router.post('/seek/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { seekTime } = req.body;

    if (!hls.hasSession(sessionId)) return res.status(404).json({ error: 'Session not found' });
    if (typeof seekTime !== 'number' || seekTime < 0) return res.status(400).json({ error: 'Invalid seekTime' });

    const result = hls.seekSession(sessionId, seekTime);
    if (result.error) return res.status(404).json(result);
    return res.json(result);
});

// ── POST /api/hls/stop/:sessionId ────────────────────────────────────────────
router.post('/stop/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    hls.stopSession(sessionId);
    return res.json({ success: true });
});

// ── GET /api/hls/status/:sessionId ───────────────────────────────────────────
router.get('/status/:sessionId', (req, res) => {
    return res.json(hls.getStatus(req.params.sessionId));
});

// ── GET /api/hls/:sessionId/index.m3u8 ───────────────────────────────────────
router.get('/:sessionId/index.m3u8', async (req, res) => {
    const { sessionId } = req.params;
    const sessionDir = path.join(config.hlsOutputBase, sessionId);
    const playlistPath = path.join(sessionDir, 'index.m3u8');

    // By the time the client requests the playlist, createSession() has already
    // waited for readiness. Just verify at least one segment exists.
    const segs = hls.listSegments(sessionDir);
    if (segs.length === 0) {
        // Tolerate brief gap on seek — wait up to 15s
        let found = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (hls.listSegments(sessionDir).length > 0) { found = true; break; }
        }
        if (!found) {
            log.error(`Playlist requested but no segments exist: ${sessionId.substring(0, 8)}`);
            return res.status(504).send('Transcode timed out');
        }
    }

    res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*',
    });

    // Serve pre-written VOD playlist if present
    if (fs.existsSync(playlistPath)) {
        return res.sendFile(path.resolve(playlistPath));
    }

    // Generate live EVENT playlist on the fly (unknown duration)
    const s = hls.getSession(sessionId);
    const segSec = (s && s.segSec) || config.hlsSegmentSec;
    const isDone = !s || s.status === 'complete' || s.status === 'stopped';
    const freshSegs = hls.listSegments(sessionDir);

    let m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${segSec}\n`;
    m3u8 += '#EXT-X-PLAYLIST-TYPE:EVENT\n\n';
    freshSegs.forEach(seg => { m3u8 += `#EXTINF:${segSec}.000000,\n${seg}\n`; });
    if (isDone) m3u8 += '#EXT-X-ENDLIST\n';

    return res.send(m3u8);
});

// ── GET /api/hls/:sessionId/:segment (.ts) ───────────────────────────────────
router.get('/:sessionId/:segment', async (req, res) => {
    const { sessionId, segment } = req.params;
    if (!segment.endsWith('.ts')) return res.status(400).send('Invalid segment type');

    const filePath = path.join(config.hlsOutputBase, sessionId, segment);

    // Long-poll: wait up to 60s for the segment to be written
    let waited = 0;
    while (!fs.existsSync(filePath) && waited < 60) {
        await new Promise(r => setTimeout(r, 1000));
        waited++;
    }

    if (!fs.existsSync(filePath)) {
        log.warn(`Segment not found after ${waited}s: ${segment} [${sessionId.substring(0, 8)}]`);
        return res.status(404).send('Segment not found');
    }

    res.set({
        'Content-Type': 'video/MP2T',
        'Cache-Control': 'public, max-age=600',
        'Access-Control-Allow-Origin': '*',
    });
    return res.sendFile(path.resolve(filePath));
});

module.exports = router;
