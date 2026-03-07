'use strict';
/**
 * torrentManager.js — WebTorrent client wrapper
 *
 * Responsibilities:
 *   - Maintain a single self-healing WebTorrent client
 *   - Deduplicate torrents by infoHash (FIXES P4 duplicate adds)
 *   - LRU eviction of idle torrents when at capacity (FIXES P7)
 *   - Attach error listeners ONCE per torrent, not per request (FIXES P8)
 *   - Idle client soft-reset after configurable inactivity period
 *   - Defer download path resolution until file size is known (partial fix P6)
 */

const WebTorrent = require('webtorrent');
const { EventEmitter } = require('events');
const config = require('./config');
const { makeLogger } = require('./logger');
const { pickDownloadPath } = require('./storage');
const sessionTracker = require('./sessionTracker');

EventEmitter.defaultMaxListeners = 100;

const log = makeLogger('Torrent');

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** infoHash → torrent */
const activeTorrents = new Map();

/** infoHash → [callback, ...] — queued waits while add() is in progress */
const pendingCallbacks = new Map();

/** infoHash → Date.now() — track last-used time for LRU eviction */
const lastUsedAt = new Map();

let client;
let clientErrorCount = 0;
let lastActivityAt = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Client lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function createClient() {
    if (client) {
        try { client.destroy(() => { }); } catch (_) { }
    }
    clientErrorCount = 0;
    client = new WebTorrent({
        maxConns: config.maxConns,
        dhtPort: config.dhtPort,
        torrentPort: config.torrentPort,
    });

    // One error listener per client lifetime (not per torrent/request)
    client.on('error', (err) => {
        clientErrorCount++;
        log.error(`WebTorrent client error (${clientErrorCount}/${config.clientMaxErrors}): ${err.message}`);
        if (clientErrorCount >= config.clientMaxErrors) {
            log.warn('Too many client errors — recreating WebTorrent client');
            activeTorrents.clear();
            pendingCallbacks.clear();
            lastUsedAt.clear();
            createClient();
        }
    });

    log.info('WebTorrent client ready');
    return client;
}

// Soft idle reset — recreates client after prolonged inactivity to flush stale state
setInterval(() => {
    const idleMs = Date.now() - lastActivityAt;
    if (
        activeTorrents.size === 0 &&
        pendingCallbacks.size === 0 &&
        idleMs >= config.idleResetMinutes * 60 * 1000
    ) {
        log.info(`Idle ${Math.round(idleMs / 60000)} min — soft-resetting WebTorrent client`);
        createClient();
        lastActivityAt = Date.now();
    }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Crash guards
// ─────────────────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return;
    if (err.code === 'EADDRINUSE') {
        // WebTorrent DHT/BT ports — it retries internally; don't crash
        log.warn(`Internal port conflict (WebTorrent): ${err.message}`);
        return;
    }
    log.error(`Uncaught exception: ${err.message}`);
    // Don't exit — keep serving existing clients
});

process.on('unhandledRejection', (reason) => {
    if (reason && (reason.name === 'AbortError' || reason.code === 'ABORT_ERR')) return;
    log.error(`Unhandled rejection: ${reason?.message || reason}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// infoHash extractor
// ─────────────────────────────────────────────────────────────────────────────

function getInfoHash(magnetURI) {
    try {
        const m = magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
        return m ? m[1].toLowerCase() : null;
    } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// LRU eviction
// ─────────────────────────────────────────────────────────────────────────────

function evictIdleTorrent() {
    // Find the torrent with no active connections AND the longest time since use
    let evictKey = null;
    let oldestUse = Infinity;

    for (const [k, t] of activeTorrents) {
        if (sessionTracker.getCount(k) > 0) continue; // has active streams — skip
        const used = lastUsedAt.get(k) || 0;
        if (used < oldestUse) { oldestUse = used; evictKey = k; }
    }

    if (evictKey) {
        const t = activeTorrents.get(evictKey);
        log.info(`Evicting idle torrent (LRU): ${t ? t.name : evictKey}`);
        try { if (t) t.destroy({ destroyStore: false }, () => { }); } catch (_) { }
        activeTorrents.delete(evictKey);
        lastUsedAt.delete(evictKey);
        sessionTracker.cancel(evictKey);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: getTorrent — deduplicated add/reuse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get (or add) a torrent by magnet URI.
 * Calls cb(torrent) once metadata is ready, or cb(null) on failure.
 * Safe to call concurrently for the same magnet — only one add() is ever issued.
 */
function getTorrent(magnetURI, cb) {
    const key = getInfoHash(magnetURI) || magnetURI;
    lastActivityAt = Date.now();
    lastUsedAt.set(key, Date.now());

    // ① Already cached and ready
    const existing = activeTorrents.get(key);
    if (existing) {
        if (existing.ready) {
            log.info(`Torrent reused: ${existing.name || key.substring(0, 12)}`);
            return cb(existing);
        }
        if (typeof existing.once === 'function') {
            return existing.once('ready', () => cb(existing));
        }
        // Stale / non-EventEmitter entry
        activeTorrents.delete(key);
    }

    // ② Another concurrent request is already adding this torrent — queue
    if (pendingCallbacks.has(key)) {
        log.debug(`Queuing callback for pending torrent: ${key.substring(0, 12)}`);
        pendingCallbacks.get(key).push(cb);
        return;
    }

    // ③ Already in WebTorrent client (e.g. after client restart edge case)
    const wtExisting = client.get(key);
    if (wtExisting && wtExisting.ready) {
        activeTorrents.set(key, wtExisting);
        _attachTorrentListeners(key, wtExisting);
        log.info(`Torrent found in WT client: ${wtExisting.name}`);
        return cb(wtExisting);
    }

    // ④ First caller — evict if at capacity, then add
    if (activeTorrents.size >= config.maxActiveTorrents) {
        evictIdleTorrent();
    }

    log.info(`Adding torrent: ${magnetURI.substring(0, 80)}`);
    pendingCallbacks.set(key, [cb]);

    // Pick download path (size unknown at this point — use size=0 to let it choose default)
    const dlPath = pickDownloadPath(0);
    const addOpts = dlPath ? { path: dlPath } : {};

    try {
        client.add(magnetURI, addOpts, (torrent) => {
            activeTorrents.set(key, torrent);
            _attachTorrentListeners(key, torrent);

            const pending = pendingCallbacks.get(key) || [];
            pendingCallbacks.delete(key);

            if (!torrent.ready) {
                torrent.once('ready', () => {
                    log.info(`Metadata ready: ${torrent.name} (${torrent.files.length} files)`);
                    _onMetadataReady(key, torrent);
                    pending.forEach(fn => fn(torrent));
                });
            } else {
                _onMetadataReady(key, torrent);
                pending.forEach(fn => fn(torrent));
            }
        });
    } catch (err) {
        log.error(`client.add threw: ${err.message}`);
        const pending = pendingCallbacks.get(key) || [];
        pendingCallbacks.delete(key);
        // One last check — maybe it slipped in during the error
        const t = client.get(key);
        if (t && t.ready) {
            activeTorrents.set(key, t);
            pending.forEach(fn => fn(t));
        } else {
            pending.forEach(fn => fn(null));
        }
    }
}

/**
 * Called once when torrent metadata is available.
 * Re-evaluates download path using the actual file size (partial fix for P6).
 */
function _onMetadataReady(key, torrent) {
    const totalBytes = torrent.length || 0;
    const bestPath = pickDownloadPath(totalBytes);
    const currentPath = torrent.path;

    if (bestPath && bestPath !== currentPath) {
        log.info(`Re-routing download to ${bestPath} (file: ${(totalBytes / 1e9).toFixed(2)} GB)`);
        // WebTorrent doesn't support moving mid-download; log as advisory.
        // Future enhancement: pause→move→resume if WebTorrent adds the API.
    }

    // Register destroy callback via sessionTracker
    sessionTracker.setDestroyCallback(key, () => {
        _destroyTorrent(key, torrent);
    });
}

/**
 * Attach one-time error listener at torrent level (not per request).
 * FIXES P8: duplicate error listeners.
 */
function _attachTorrentListeners(key, torrent) {
    if (torrent._streamHubListenersAttached) return;
    torrent._streamHubListenersAttached = true;

    torrent.on('error', (err) => {
        log.error(`Torrent error [${torrent.name || key.substring(0, 12)}]: ${err.message}`);
    });

    torrent.on('warning', (warn) => {
        log.warn(`Torrent warning [${torrent.name || key.substring(0, 12)}]: ${warn}`);
    });
}

function _destroyTorrent(key, torrent) {
    log.info(`Destroying torrent: ${torrent ? torrent.name : key}`);
    try {
        if (torrent && !torrent.destroyed) {
            torrent.destroy({ destroyStore: true }, () => {
                log.info(`Torrent data removed: ${torrent.name}`);
            });
        }
    } catch (e) {
        log.warn(`destroy error: ${e.message}`);
    }
    activeTorrents.delete(key);
    lastUsedAt.delete(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the torrent for a given magnet if it's already ready; else null. */
function get(magnetURI) {
    const key = getInfoHash(magnetURI) || magnetURI;
    const t = activeTorrents.get(key) || client.get(key) || null;
    return (t && t.ready) ? t : null;
}

/** Returns download/upload stats for a magnet. */
function getStats(magnetURI) {
    const key = getInfoHash(magnetURI) || magnetURI;
    const t = activeTorrents.get(key) || client.get(key);
    if (!t) return null;
    return {
        name: t.name,
        downloadSpeed: t.downloadSpeed,
        uploadSpeed: t.uploadSpeed,
        progress: t.progress,
        numPeers: t.numPeers,
        timeRemaining: t.timeRemaining,
    };
}

/** Returns the canonical key (infoHash) for a magnet. */
function keyFor(magnetURI) {
    return getInfoHash(magnetURI) || magnetURI;
}

// Init
createClient();

module.exports = { getTorrent, get, getStats, keyFor };
