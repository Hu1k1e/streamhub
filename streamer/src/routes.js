'use strict';
/**
 * routes.js — Express route handlers for the Streamer
 *
 * GET /stream?magnet=...  — stream the video (direct from disk or from WebTorrent)
 * GET /info?magnet=...    — return file metadata (name, size, extension, streamUrl)
 * GET /status?magnet=...  — return torrent download stats
 */

const express = require('express');
const torrentManager = require('./torrentManager');
const sessionTracker = require('./sessionTracker');
const { selectBestFile } = require('./fileSelector');
const { findExistingFile } = require('./storage');
const { serveFromDisk, serveFromTorrent } = require('./streamHandler');
const { makeLogger } = require('./logger');

const log = makeLogger('Routes');
const router = express.Router();

// ── GET /stream ────────────────────────────────────────────────────────────────
router.get('/stream', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).send('Missing "magnet" query parameter.');

    // Fast path: file already on disk (not managed by WebTorrent)
    const existingFile = findExistingFile(magnetURI);
    if (existingFile) {
        log.info(`Serving from disk: ${existingFile}`);
        return serveFromDisk(existingFile, req, res);
    }

    // Slow path: WebTorrent streaming
    torrentManager.getTorrent(magnetURI, (torrent) => {
        if (!torrent) {
            log.error(`getTorrent returned null for: ${magnetURI.substring(0, 60)}`);
            if (!res.headersSent) return res.status(500).send('Failed to load torrent');
            return;
        }

        if (!torrent.files || torrent.files.length === 0) {
            log.error(`No files in torrent: ${torrent.name}`);
            if (!res.headersSent) return res.status(500).send('Torrent has no files');
            return;
        }

        const file = selectBestFile(torrent.files);
        if (!file) {
            log.error(`No suitable video file in torrent: ${torrent.name}`);
            if (!res.headersSent) return res.status(500).send('No playable file found');
            return;
        }

        const key = torrentManager.keyFor(magnetURI);
        log.info(`Streaming: ${file.name} (${(file.length / 1e9).toFixed(2)} GB)`);

        // Reference counting — prevents cleanup while stream is active
        sessionTracker.open(key);

        serveFromTorrent(file, req, res, () => {
            // Called on req.close
            log.info(`Stream closed: ${file.name}`);
            sessionTracker.close(key);
        });
    });
});

// ── GET /info ──────────────────────────────────────────────────────────────────
router.get('/info', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    log.info(`Info request: ${magnetURI.substring(0, 80)}`);

    // Fast path: disk
    const existingFile = findExistingFile(magnetURI);
    if (existingFile) {
        const fs = require('fs');
        const path = require('path');
        const name = path.basename(existingFile);
        const ext = name.toLowerCase().split('.').pop();
        const size = fs.statSync(existingFile).size;
        log.info(`Info from disk: ${name}`);
        return res.json({
            name,
            size,
            extension: ext,
            streamUrl: `/stream?magnet=${encodeURIComponent(magnetURI)}`,
        });
    }

    torrentManager.getTorrent(magnetURI, (torrent) => {
        if (!torrent || !torrent.files || torrent.files.length === 0) {
            log.error(`Info: no files for ${magnetURI.substring(0, 60)}`);
            return res.status(500).json({ error: 'No files in torrent' });
        }

        const file = selectBestFile(torrent.files);
        if (!file) {
            return res.status(500).json({ error: 'No playable file found' });
        }

        const ext = file.name.toLowerCase().split('.').pop();
        log.info(`Info: ${file.name} (${(file.length / 1e9).toFixed(2)} GB)`);

        res.json({
            name: file.name,
            size: file.length,
            extension: ext,
            streamUrl: `/stream?magnet=${encodeURIComponent(magnetURI)}`,
        });
    });
});

// ── GET /status ────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    const stats = torrentManager.getStats(magnetURI);
    if (!stats) return res.json({ status: 'not_found' });
    res.json(stats);
});

module.exports = router;
