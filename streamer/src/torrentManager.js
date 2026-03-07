/**
 * torrentManager.js — WebTorrent client wrapper (ESM)
 *
 * webtorrent v2.x is ESM-only — this file must be ESM.
 */

import WebTorrent from 'webtorrent';
import { EventEmitter } from 'events';
import config from './config.js';
import { makeLogger } from './logger.js';
import { pickDownloadPath } from './storage.js';
import * as sessionTracker from './sessionTracker.js';

EventEmitter.defaultMaxListeners = 100;

const log = makeLogger('Torrent');

/** infoHash → torrent */
const activeTorrents = new Map();

/** infoHash → [callback, ...] — queued waits while add() is in progress */
const pendingCallbacks = new Map();

/** infoHash → timestamp — for LRU eviction */
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

// Soft idle reset
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
    if (err.code === 'EADDRINUSE') { log.warn(`Internal port conflict (WebTorrent): ${err.message}`); return; }
    log.error(`Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
    if (reason && (reason.name === 'AbortError' || reason.code === 'ABORT_ERR')) return;
    log.error(`Unhandled rejection: ${reason?.message || reason}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getInfoHash(magnetURI) {
    try {
        const m = magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
        return m ? m[1].toLowerCase() : null;
    } catch (_) { return null; }
}

function evictIdleTorrent() {
    let evictKey = null;
    let oldestUse = Infinity;

    for (const [k, t] of activeTorrents) {
        if (sessionTracker.getCount(k) > 0) continue;
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

function _attachTorrentListeners(key, torrent) {
    if (torrent._streamHubListenersAttached) return;
    torrent._streamHubListenersAttached = true;
    torrent.on('error', (err) => log.error(`Torrent error [${torrent.name || key.substring(0, 12)}]: ${err.message}`));
    torrent.on('warning', (warn) => log.warn(`Torrent warning [${torrent.name || key.substring(0, 12)}]: ${warn}`));
}

function _onMetadataReady(key, torrent) {
    const totalBytes = torrent.length || 0;
    const bestPath = pickDownloadPath(totalBytes);
    if (bestPath && bestPath !== torrent.path) {
        log.info(`Re-routing advised to ${bestPath} (file: ${(totalBytes / 1e9).toFixed(2)} GB) — apply on restart`);
    }
    sessionTracker.setDestroyCallback(key, () => _destroyTorrent(key, torrent));
}

function _destroyTorrent(key, torrent) {
    log.info(`Destroying torrent: ${torrent ? torrent.name : key}`);
    try {
        if (torrent && !torrent.destroyed) torrent.destroy({ destroyStore: true }, () => log.info(`Torrent data removed: ${torrent.name}`));
    } catch (e) { log.warn(`destroy error: ${e.message}`); }
    activeTorrents.delete(key);
    lastUsedAt.delete(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: getTorrent
// ─────────────────────────────────────────────────────────────────────────────

export function getTorrent(magnetURI, cb) {
    const key = getInfoHash(magnetURI) || magnetURI;
    lastActivityAt = Date.now();
    lastUsedAt.set(key, Date.now());

    // Already cached and ready
    const existing = activeTorrents.get(key);
    if (existing) {
        if (existing.ready) { log.info(`Torrent reused: ${existing.name || key.substring(0, 12)}`); return cb(existing); }
        if (typeof existing.once === 'function') return existing.once('ready', () => cb(existing));
        activeTorrents.delete(key);
    }

    // Another request is already adding this torrent — queue
    if (pendingCallbacks.has(key)) {
        log.debug(`Queuing callback for pending torrent: ${key.substring(0, 12)}`);
        pendingCallbacks.get(key).push(cb);
        return;
    }

    // Already in WebTorrent client
    const wtExisting = client.get(key);
    if (wtExisting && wtExisting.ready) {
        activeTorrents.set(key, wtExisting);
        _attachTorrentListeners(key, wtExisting);
        log.info(`Torrent found in WT client: ${wtExisting.name}`);
        return cb(wtExisting);
    }

    // First caller
    if (activeTorrents.size >= config.maxActiveTorrents) evictIdleTorrent();

    log.info(`Adding torrent: ${magnetURI.substring(0, 80)}`);
    pendingCallbacks.set(key, [cb]);

    const dlPath = pickDownloadPath(0);
    const addOpts = dlPath ? { path: dlPath } : {};

    try {
        client.add(magnetURI, addOpts, (torrent) => {
            activeTorrents.set(key, torrent);
            _attachTorrentListeners(key, torrent);

            const pending = pendingCallbacks.get(key) || [];
            pendingCallbacks.delete(key);

            const done = () => { _onMetadataReady(key, torrent); pending.forEach(fn => fn(torrent)); };

            if (!torrent.ready) torrent.once('ready', () => { log.info(`Metadata ready: ${torrent.name} (${torrent.files.length} files)`); done(); });
            else done();
        });
    } catch (err) {
        log.error(`client.add threw: ${err.message}`);
        const pending = pendingCallbacks.get(key) || [];
        pendingCallbacks.delete(key);
        const t = client.get(key);
        if (t && t.ready) { activeTorrents.set(key, t); pending.forEach(fn => fn(t)); }
        else pending.forEach(fn => fn(null));
    }
}

export function get(magnetURI) {
    const key = getInfoHash(magnetURI) || magnetURI;
    const t = activeTorrents.get(key) || client.get(key) || null;
    return (t && t.ready) ? t : null;
}

export function getStats(magnetURI) {
    const key = getInfoHash(magnetURI) || magnetURI;
    const t = activeTorrents.get(key) || client.get(key);
    if (!t) return null;
    return { name: t.name, downloadSpeed: t.downloadSpeed, uploadSpeed: t.uploadSpeed, progress: t.progress, numPeers: t.numPeers, timeRemaining: t.timeRemaining };
}

export function keyFor(magnetURI) {
    return getInfoHash(magnetURI) || magnetURI;
}

// Init
createClient();
