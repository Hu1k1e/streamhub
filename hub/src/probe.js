'use strict';
/**
 * probe.js — Single source of truth for direct-play capability detection.
 *
 * Used by:
 *   - /api/probe  (server-side)
 *
 * Client-side (app.js) has its own quickProbeFromMagnet() for zero-latency decisions;
 * this server copy is authoritative for the slow path (no dn= in magnet).
 */

/**
 * Parse the dn= parameter from a magnet URI.
 * Returns { name, extension } or null.
 */
function parseMagnetDn(magnetURI) {
    try {
        const params = new URLSearchParams(magnetURI.replace(/^magnet:\?/i, ''));
        const dn = params.get('dn');
        if (dn) {
            const name = decodeURIComponent(dn).trim();
            const parts = name.split('.');
            const extension = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
            return { name, extension };
        }
    } catch (_) { /* ignore */ }
    return null;
}

/**
 * Determine whether a given file can be direct-played given the client's capability flags.
 *
 * @param {{ name: string, extension: string }} fileInfo
 * @param {{ isSafari: boolean, canHevc: boolean, canH264: boolean, canVP9: boolean, canAV1: boolean, canMkv: boolean }} caps
 * @returns {{ canDirectPlay: boolean, codec: string }}
 */
function determineDirectPlay(fileInfo, caps) {
    const name = (fileInfo.name || '').toLowerCase();
    const ext = (fileInfo.extension || '').toLowerCase();

    const isHEVC = /\b(x265|hevc|h\.?265)\b/.test(name);
    const isAV1 = /\bav1\b/.test(name);
    const isVP9 = /\bvp9\b/.test(name);

    const codec = isHEVC ? 'hevc' : isAV1 ? 'av1' : isVP9 ? 'vp9' : 'h264';

    // Codec support from client's canPlayType() probing
    const codecOk = isHEVC ? caps.canHevc
        : isAV1 ? caps.canAV1
            : isVP9 ? caps.canVP9
                : caps.canH264;   // default: assume H.264

    // AVI always requires transcoding — no modern browser supports it natively
    if (ext === 'avi') return { canDirectPlay: false, codec };

    // Container support
    let containerOk;
    if (ext === 'mp4' || ext === 'm4v') {
        containerOk = caps.canH264; // MP4 needs at least H.264 support
    } else if (ext === 'webm') {
        containerOk = caps.canVP9 || caps.canAV1;
    } else if (ext === 'mkv') {
        // Desktop browsers can play MKV with H.264/VP9 even when canPlayType returns ''
        containerOk = !caps.isSafari || caps.canMkv;
    } else {
        containerOk = true; // unknown extension → optimistic
    }

    // Safari: force transcode for any known non-MP4 video container
    const SAFARI_MP4_EXTS = new Set(['mp4', 'm4v', 'mov']);
    const KNOWN_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mkv', 'webm', 'avi', 'ts', 'mov', 'm2ts', 'mpeg', 'mpg']);
    if (caps.isSafari && KNOWN_VIDEO_EXTS.has(ext) && !SAFARI_MP4_EXTS.has(ext)) {
        containerOk = false;
    }
    // Safari + unknown ext + HEVC → likely MKV → transcode
    if (caps.isSafari && !KNOWN_VIDEO_EXTS.has(ext) && isHEVC) {
        containerOk = false;
    }

    return { canDirectPlay: codecOk && containerOk, codec };
}

module.exports = { parseMagnetDn, determineDirectPlay };
