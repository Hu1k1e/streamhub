'use strict';
/**
 * sessionTracker.js — Per-torrent reference counting
 *
 * FIXES BUG P2: The 5-minute destroy timer previously fired on every HTTP
 * disconnect, including seeks (which close and reopen connections rapidly).
 * This module tracks the number of active HTTP connections reading each torrent,
 * and only starts the idle timer when the count genuinely drops to zero AND
 * remains at zero for the full delay.
 *
 * Usage:
 *   sessionTracker.open(key)   — call when a /stream request starts
 *   sessionTracker.close(key)  — call when the request closes
 *   sessionTracker.setDestroyCallback(key, fn)  — called when idle timer fires
 *   sessionTracker.cancel(key) — call if torrent is destroyed externally
 */

const config = require('./config');
const { makeLogger } = require('./logger');

const log = makeLogger('Session');

/** infoHash → { count: number, timer: NodeJS.Timeout|null, destroyFn: Function|null } */
const state = new Map();

function ensureEntry(key) {
    if (!state.has(key)) {
        state.set(key, { count: 0, timer: null, destroyFn: null });
    }
    return state.get(key);
}

/**
 * Register an active stream connection.
 * Cancels any pending idle timer.
 */
function open(key) {
    const entry = ensureEntry(key);
    entry.count++;
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        log.debug(`Timer cancelled (new connection): ${key.substring(0, 12)}`);
    }
    log.info(`Connection opened [${key.substring(0, 12)}] — active: ${entry.count}`);
}

/**
 * Unregister a stream connection.
 * If count drops to zero, start the idle timer.
 */
function close(key) {
    const entry = state.get(key);
    if (!entry) return;

    entry.count = Math.max(0, entry.count - 1);
    log.info(`Connection closed [${key.substring(0, 12)}] — active: ${entry.count}`);

    if (entry.count === 0) {
        _scheduleDestroy(key, entry);
    }
}

/**
 * Set (or replace) the callback to fire when the idle timer expires.
 * This should be called right after adding/reusing a torrent.
 */
function setDestroyCallback(key, fn) {
    const entry = ensureEntry(key);
    entry.destroyFn = fn;
}

/**
 * Immediately cancel tracking for this key (e.g. torrent was destroyed externally).
 */
function cancel(key) {
    const entry = state.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    state.delete(key);
}

/** Active stream count for a key. */
function getCount(key) {
    return state.get(key)?.count ?? 0;
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _scheduleDestroy(key, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    log.info(`No active streams [${key.substring(0, 12)}] — idle timer starts (${config.cleanupDelayMs / 1000}s)`);
    entry.timer = setTimeout(() => {
        log.info(`Idle timer fired [${key.substring(0, 12)}] — destroying`);
        state.delete(key);
        if (entry.destroyFn) {
            try { entry.destroyFn(); } catch (e) { log.error(`destroyFn threw: ${e.message}`); }
        }
    }, config.cleanupDelayMs);
}

module.exports = { open, close, setDestroyCallback, cancel, getCount };
