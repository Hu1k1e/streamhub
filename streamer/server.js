import express from 'express';
import WebTorrent from 'webtorrent';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = 100;

const PORT = 6987;
const MAX_ACTIVE_TORRENTS = 5; // evict oldest idle torrent when limit reached

const app = express();
app.use(cors());

// ─── Self-healing WebTorrent client ───────────────────────────────────────────
let client;
let clientErrorCount = 0;
const MAX_CLIENT_ERRORS = 3;

function createClient() {
    if (client) {
        try { client.destroy(() => { }); } catch { }
    }
    clientErrorCount = 0;
    client = new WebTorrent({ maxConns: 30 }); // cap peer connections per torrent
    client.on('error', (err) => {
        clientErrorCount++;
        console.error(`[!] WebTorrent Client Error (${clientErrorCount}/${MAX_CLIENT_ERRORS}):`, err.message);
        if (clientErrorCount >= MAX_CLIENT_ERRORS) {
            console.warn('[!] Too many client errors — recreating WebTorrent client...');
            // Clear our maps so old references don't linger
            activeTorrents.clear();
            pendingCallbacks.clear();
            createClient();
        }
    });
    console.log('[✓] WebTorrent client ready');
    return client;
}
createClient();

// ─── Crash guards ─────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return;
    if (err.code === 'EADDRINUSE') {
        console.error(`[!] Port ${PORT} is already in use — another streamer instance is running.`);
        console.error('[!] Kill the existing process and restart.');
        process.exit(1); // start.bat loop will kill zombie and retry
    }
    console.error('[!] Uncaught Exception:', err.message);
    // Don't crash — keep serving existing requests
});
process.on('unhandledRejection', (reason) => {
    if (reason && (reason.name === 'AbortError' || reason.code === 'ABORT_ERR')) return;
    console.error('[!] Unhandled Rejection:', reason?.message || reason);
});


// ─── Storage Configuration ─────────────────────────────────────────────────────
const DEFAULT_DL_PATH = process.env.DEFAULT_DL_PATH || null;
const FALLBACK_DL_PATH = process.env.FALLBACK_DL_PATH || 'D:/TempMovies';
const LARGE_FILE_THRESHOLD_GB = parseFloat(process.env.LARGE_FILE_THRESHOLD_GB || '20');

function getDiskFreeBytes(drivePath) {
    try {
        const drive = path.parse(drivePath).root.replace(/\\/g, '');
        const result = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, { encoding: 'utf8' });
        const match = result.match(/FreeSpace=(\d+)/);
        if (match) return parseInt(match[1], 10);
    } catch (e) { console.warn(`[!] Could not check free space for ${drivePath}:`, e.message); }
    return Infinity;
}

function pickDownloadPath(fileSizeBytes) {
    if (!DEFAULT_DL_PATH && !FALLBACK_DL_PATH) return undefined;
    const thresholdBytes = LARGE_FILE_THRESHOLD_GB * 1024 * 1024 * 1024;
    if (DEFAULT_DL_PATH && fileSizeBytes <= thresholdBytes) {
        const freeBytes = getDiskFreeBytes(DEFAULT_DL_PATH);
        if (freeBytes > fileSizeBytes * 1.1) return DEFAULT_DL_PATH;
    }
    if (FALLBACK_DL_PATH) {
        if (!fs.existsSync(FALLBACK_DL_PATH)) fs.mkdirSync(FALLBACK_DL_PATH, { recursive: true });
        return FALLBACK_DL_PATH;
    }
    return undefined;
}

// ─── Torrent State ─────────────────────────────────────────────────────────────
// Key: infoHash (lower-case hex) — stable regardless of magnet URL encoding/ordering
const activeTorrents = new Map(); // infoHash → torrent
const pendingCallbacks = new Map(); // infoHash → [callbacks...]

/** Extract the 40-char hex info-hash from any magnet URI. */
function getInfoHash(magnetURI) {
    try {
        const m = magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
        return m ? m[1].toLowerCase() : null;
    } catch { return null; }
}

/**
 * Safe torrent getter — deduplicates on infoHash so two requests for the same
 * torrent with different magnet strings never both call client.add().
 * Also guards against WebTorrent returning plain objects without EventEmitter.
 */
function getTorrent(magnetURI, callback) {
    const key = getInfoHash(magnetURI) || magnetURI;

    // ①  Check our cache — only trust it if it has EventEmitter or is already ready
    const existing = activeTorrents.get(key);
    if (existing) {
        if (existing.ready) return callback(existing);
        if (typeof existing.once === 'function') {
            return existing.once('ready', () => callback(existing));
        }
        // Stale/non-EventEmitter entry — clear it and fall through to re-add
        activeTorrents.delete(key);
    }

    // ②  Another concurrent request is already calling client.add() — queue
    if (pendingCallbacks.has(key)) {
        pendingCallbacks.get(key).push(callback);
        return;
    }

    // ③  Ask WebTorrent directly — only use if already ready (plain objects can't subscribe)
    const wtExisting = client.get(key);
    if (wtExisting && wtExisting.ready) {
        activeTorrents.set(key, wtExisting);
        return callback(wtExisting);
    }

    // ④  First caller — initiate add
    // Evict oldest idle torrent if at the limit (prevents file-handle/connection exhaustion)
    if (activeTorrents.size >= MAX_ACTIVE_TORRENTS) {
        for (const [evictKey, t] of activeTorrents) {
            if ((t.activeConnections || 0) === 0) {
                console.log(`[~] Evicting idle torrent to stay under limit: ${t.name || evictKey}`);
                try { t.destroy({ destroyStore: false }, () => { }); } catch { }
                activeTorrents.delete(evictKey);
                break;
            }
        }
    }

    console.log(`[+] Adding torrent: ${magnetURI.substring(0, 60)}...`);
    pendingCallbacks.set(key, [callback]);

    const dlPath = DEFAULT_DL_PATH || FALLBACK_DL_PATH || undefined;
    const addOpts = dlPath ? { path: dlPath } : {};

    try {
        client.add(magnetURI, addOpts, (torrent) => {
            // The callback torrent IS a proper EventEmitter — safe to use .once
            activeTorrents.set(key, torrent);
            const pending = pendingCallbacks.get(key) || [];
            pendingCallbacks.delete(key);
            if (!torrent.ready) {
                torrent.once('ready', () => pending.forEach(cb => cb(torrent)));
            } else {
                pending.forEach(cb => cb(torrent));
            }
        });
    } catch (err) {
        console.error(`[!] client.add threw: ${err.message}`);
        const pending = pendingCallbacks.get(key) || [];
        pendingCallbacks.delete(key);
        // Best-effort recovery: check if already in client
        const t = client.get(key);
        if (t && t.ready) { activeTorrents.set(key, t); pending.forEach(cb => cb(t)); }
        else pending.forEach(cb => cb(null));
    }
}


// ─── Direct file lookup (fast path for pre-existing downloads) ────────────────
const VIDEO_EXTS_RE = /\.(mp4|m4v|mkv|webm|avi|ts|mov|m2ts|mpeg|mpg)$/i;

/** Scan download paths for a video file matching the torrent name. Returns full path or null. */
function findExistingFile(magnetURI) {
    const searchDirs = [DEFAULT_DL_PATH, FALLBACK_DL_PATH].filter(Boolean);
    if (!searchDirs.length) return null;
    try {
        const dn = new URLSearchParams(magnetURI.replace(/^magnet:\?/i, '')).get('dn');
        const torrentName = dn ? decodeURIComponent(dn) : null;
        for (const baseDir of searchDirs) {
            if (!fs.existsSync(baseDir)) continue;
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const entry of entries) {
                // Match by torrent name (folder) or loose file in root
                const nameMatch = torrentName && entry.name === torrentName;
                if (entry.isDirectory() && nameMatch) {
                    const subDir = path.join(baseDir, entry.name);
                    const videoFile = fs.readdirSync(subDir)
                        .filter(f => VIDEO_EXTS_RE.test(f))
                        .map(f => ({ name: f, size: fs.statSync(path.join(subDir, f)).size }))
                        .sort((a, b) => b.size - a.size)[0];
                    if (videoFile) return path.join(subDir, videoFile.name);
                }
                if (entry.isFile() && VIDEO_EXTS_RE.test(entry.name) && nameMatch) {
                    return path.join(baseDir, entry.name);
                }
            }
        }
    } catch (e) { console.warn('[!] findExistingFile error:', e.message); }
    return null;
}

/** Serve a file from disk directly (fast, no WebTorrent hash check). */
function serveFileFromDisk(filePath, req, res) {
    const total = fs.statSync(filePath).size;
    const ext = filePath.toLowerCase().split('.').pop();
    let mimeType = 'video/mp4';
    if (ext === 'mkv') mimeType = 'video/x-matroska';
    else if (ext === 'webm') mimeType = 'video/webm';
    else if (ext === 'avi') mimeType = 'video/x-msvideo';

    const range = req.headers.range;
    const start = range ? parseInt(range.replace(/bytes=/, '').split('-')[0], 10) : 0;
    const end = (range && range.replace(/bytes=/, '').split('-')[1])
        ? parseInt(range.replace(/bytes=/, '').split('-')[1], 10) : total - 1;
    const chunksize = end - start + 1;

    console.log(`[▶] Direct-file serve: ${path.basename(filePath)} (${(total / 1024 / 1024 / 1024).toFixed(2)} GB) bytes ${start}-${end}`);
    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => { });
    res.on('error', () => { });
    stream.pipe(res);
    req.on('close', () => stream.destroy());
}

// ─── Startup cleanup: remove directories older than 12h ──────────────────────
function runStartupCleanup() {
    const dirs = [DEFAULT_DL_PATH, FALLBACK_DL_PATH].filter(Boolean);
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    for (const baseDir of dirs) {
        if (!fs.existsSync(baseDir)) continue;
        try {
            fs.readdirSync(baseDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .forEach(e => {
                    try {
                        const fullPath = path.join(baseDir, e.name);
                        const stat = fs.statSync(fullPath);
                        if (stat.mtimeMs < cutoff) {
                            fs.rmSync(fullPath, { recursive: true, force: true });
                            console.log(`[🗑] Startup cleanup: removed ${fullPath}`);
                        }
                    } catch { }
                });
        } catch { }
    }
}
setTimeout(runStartupCleanup, 5000); // Run 5s after startup

// ─── /stream endpoint ─────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).send('Missing "magnet" query parameter.');

    // Fast path: if file already exists on disk, serve directly (no hash check wait)
    const existingFile = findExistingFile(magnetURI);
    if (existingFile) {
        serveFileFromDisk(existingFile, req, res);
        return;
    }

    getTorrent(magnetURI, (torrent) => {
        handleStream(torrent, req, res, magnetURI);
    });
});


function handleStream(torrent, req, res, magnetURI) {
    if (!torrent || !torrent.files || torrent.files.length === 0) {
        console.error(`[!] No files found for torrent: ${torrent?.name || 'unknown'}`);
        if (!res.headersSent) res.status(500).send('Torrent has no files');
        return;
    }

    if (!torrent.activeConnections) torrent.activeConnections = 0;
    torrent.activeConnections++;
    if (torrent.idleTimeout) { clearTimeout(torrent.idleTimeout); torrent.idleTimeout = null; }

    console.log(`[✓] Torrent Ready: ${torrent.name} (Connections: ${torrent.activeConnections})`);

    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    console.log(`[▶] Streaming: ${file.name} (${(file.length / 1024 / 1024 / 1024).toFixed(2)} GB)`);

    let mimeType = 'video/mp4';
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === 'mkv') mimeType = 'video/x-matroska';
    else if (ext === 'webm') mimeType = 'video/webm';
    else if (ext === 'avi') mimeType = 'video/x-msvideo';

    const range = req.headers.range;
    const total = file.length;

    // Always respond with 206 Partial Content — Chrome/Firefox reliably start playback
    // from 206 responses. A 200 full-file response for MKV/large files can stall the browser.
    const start = range ? parseInt(range.replace(/bytes=/, '').split('-')[0], 10) : 0;
    const end = (range && range.replace(/bytes=/, '').split('-')[1])
        ? parseInt(range.replace(/bytes=/, '').split('-')[1], 10)
        : total - 1;
    const chunksize = end - start + 1;

    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
    });

    const stream = file.createReadStream({ start, end });
    stream.on('error', () => { });
    res.on('error', () => { });
    stream.pipe(res);

    req.on('close', () => {
        stream.destroy();
        onConnectionClose(torrent, magnetURI);
    });

    torrent.on('error', (err) => {
        console.error(`[!] Torrent error: ${err.message}`);
        if (!res.headersSent) res.status(500).send(`Torrent Error: ${err.message}`);
    });

}

function onConnectionClose(torrent, magnetURI) {
    torrent.activeConnections = Math.max(0, (torrent.activeConnections || 1) - 1);
    if (torrent.activeConnections <= 0) {
        console.log(`[!] No active streams for "${torrent.name}". Starting 5-min cleanup timer...`);
        const key = getInfoHash(magnetURI) || magnetURI;
        torrent.idleTimeout = setTimeout(() => {
            console.log(`[🗑] Destroying idle torrent: ${torrent.name}`);
            torrent.destroy({ destroyStore: true }, () => { console.log(`[🗑] Cleaned: ${torrent.name}`); });
            activeTorrents.delete(key);
        }, 5 * 60 * 1000);
    }
}


// ─── /info endpoint ───────────────────────────────────────────────────────────
app.get('/info', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    console.log(`[i] Info request: ${magnetURI.substring(0, 60)}...`);

    // Fast path: if file already exists on disk, return info immediately (no hash check wait)
    const existingFile = findExistingFile(magnetURI);
    if (existingFile) {
        const fileName = path.basename(existingFile);
        const ext = fileName.toLowerCase().split('.').pop();
        const size = fs.statSync(existingFile).size;
        console.log(`[i] Found on disk: ${fileName}`);
        return res.json({ name: fileName, size, extension: ext, streamUrl: `/stream?magnet=${encodeURIComponent(magnetURI)}` });
    }

    getTorrent(magnetURI, (torrent) => {
        if (!torrent || !torrent.files || torrent.files.length === 0) {
            return res.status(500).json({ error: 'No files in torrent' });
        }
        const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
        const ext = file.name.toLowerCase().split('.').pop();
        res.json({
            name: file.name,
            size: file.length,
            extension: ext,
            streamUrl: `/stream?magnet=${encodeURIComponent(magnetURI)}`,
        });
    });
});


// ─── /status endpoint ─────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.json({ error: 'Missing magnet' });
    const torrent = client.get(magnetURI);
    if (!torrent) return res.json({ status: 'not_found' });
    res.json({ name: torrent.name, downloadSpeed: torrent.downloadSpeed, uploadSpeed: torrent.uploadSpeed, progress: torrent.progress, numPeers: torrent.numPeers, timeRemaining: torrent.timeRemaining });
});

const server = app.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🚀 WebTorrent Streamer running on port ${PORT}`);
    console.log(`📡 Primary path  : ${DEFAULT_DL_PATH || '(WebTorrent default)'}`);
    console.log(`📦 Fallback path : ${FALLBACK_DL_PATH}`);
    console.log(`📏 Large file threshold: ${LARGE_FILE_THRESHOLD_GB} GB`);
    console.log(`🎭 Max active torrents: ${MAX_ACTIVE_TORRENTS}`);
    console.log('====================================================');
});
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[!] Port ${PORT} already in use. Exiting so start.bat can kill the zombie and retry.`);
        process.exit(1);
    }
    console.error('[!] Server error:', err.message);
});
