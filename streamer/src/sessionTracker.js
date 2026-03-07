import config from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('Session');

/** infoHash → { count, timer, destroyFn } */
const state = new Map();

function ensureEntry(key) {
    if (!state.has(key)) state.set(key, { count: 0, timer: null, destroyFn: null });
    return state.get(key);
}

export function open(key) {
    const entry = ensureEntry(key);
    entry.count++;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    log.info(`Connection opened [${key.substring(0, 12)}] — active: ${entry.count}`);
}

export function close(key) {
    const entry = state.get(key);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    log.info(`Connection closed [${key.substring(0, 12)}] — active: ${entry.count}`);
    if (entry.count === 0) _scheduleDestroy(key, entry);
}

export function setDestroyCallback(key, fn) {
    ensureEntry(key).destroyFn = fn;
}

export function cancel(key) {
    const entry = state.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    state.delete(key);
}

export function getCount(key) {
    return state.get(key)?.count ?? 0;
}

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
