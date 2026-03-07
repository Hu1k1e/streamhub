'use strict';
/**
 * streamHandler.js — HTTP range-request streaming
 *
 * Handles two stream sources:
 *   1. Disk files (pre-downloaded, served directly via fs.createReadStream)
 *   2. WebTorrent files (streaming in real time via torrent file.createReadStream)
 *
 * Both paths:
 *   - Parse Range header correctly
 *   - Always respond with 206 (Chrome/Firefox start reliably with range responses)
 *   - Set correct MIME type
 *   - Clamp range bounds to file length
 *   - Clean up stream on client disconnect
 */

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('./logger');

const log = makeLogger('Stream');

const MIME = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    ts: 'video/MP2T',
    m2ts: 'video/MP2T',
    mpeg: 'video/mpeg',
    mpg: 'video/mpeg',
};

function getMime(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    return MIME[ext] || 'application/octet-stream';
}

/** Parse Range header → { start, end } or null (200 full-file response). */
function parseRange(rangeHeader, total) {
    if (!rangeHeader) return { start: 0, end: total - 1 };

    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) return { start: 0, end: total - 1 };

    let start = match[1] !== '' ? parseInt(match[1], 10) : 0;
    let end = match[2] !== '' ? parseInt(match[2], 10) : total - 1;

    // Clamp
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;

    // Malformed (start > end) — serve from start to EOF
    if (start > end) end = total - 1;

    return { start, end };
}

function writeHeaders(res, start, end, total, mimeType) {
    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
    });
}

// ── Disk file serving ─────────────────────────────────────────────────────────

/**
 * Serve an already-complete disk file with range support.
 * Used for pre-downloaded movies.
 */
function serveFromDisk(filePath, req, res) {
    try {
        const total = fs.statSync(filePath).size;
        const mimeType = getMime(filePath);
        const { start, end } = parseRange(req.headers.range, total);

        if (start >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            return res.end();
        }

        log.info(`Disk serve: ${path.basename(filePath)} (${(total / 1e9).toFixed(2)} GB) bytes ${start}-${end}`);

        writeHeaders(res, start, end, total, mimeType);
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', (err) => { log.warn(`Disk stream error: ${err.message}`); });
        res.on('error', () => { });
        req.on('close', () => stream.destroy());
        stream.pipe(res);
    } catch (err) {
        log.error(`serveFromDisk error: ${err.message}`);
        if (!res.headersSent) res.status(500).send('File serve error');
    }
}

// ── WebTorrent file serving ───────────────────────────────────────────────────

/**
 * Serve a WebTorrent TorrentFile with range support.
 * Prioritizes downloading pieces near `start` for fast first-frame display.
 *
 * @param {import('webtorrent').TorrentFile} file
 * @param {import('http').IncomingMessage}   req
 * @param {import('http').ServerResponse}    res
 * @param {Function} onClose — called when the request closes (for reference counting)
 */
function serveFromTorrent(file, req, res, onClose) {
    const total = file.length;
    const mimeType = getMime(file.name);
    const { start, end } = parseRange(req.headers.range, total);

    if (start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
    }

    log.info(`Torrent serve: ${file.name} (${(total / 1e9).toFixed(2)} GB) bytes ${start}-${end}`);

    writeHeaders(res, start, end, total, mimeType);

    // Priority: download pieces covering the requested range first
    // This dramatically speeds up first-frame display for seeks
    try {
        file.select();
        // WebTorrent doesn't expose piece-level priority on file directly,
        // but selecting + starting the stream from `start` causes it to
        // prioritize the right pieces.
    } catch (_) { }

    const stream = file.createReadStream({ start, end });
    stream.on('error', (err) => {
        // Suppress "Writable stream closed prematurely" — happens normally on seek
        if (err.message && err.message.includes('premature')) return;
        log.warn(`Torrent stream error: ${err.message}`);
    });
    res.on('error', () => { });

    stream.pipe(res);

    req.on('close', () => {
        stream.destroy();
        if (typeof onClose === 'function') onClose();
    });
}

module.exports = { serveFromDisk, serveFromTorrent };
