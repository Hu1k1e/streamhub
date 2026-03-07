'use strict';
/**
 * hlsManager.js — HLS transcode session lifecycle manager.
 *
 * Responsibilities:
 *   - Create, track, and destroy FFmpeg transcode sessions
 *   - Handle seek: kill old FFmpeg, restart from new position
 *   - Reference counting: defer cleanup until consumers are gone
 *   - Schedule 5-minute cleanup after all consumers disconnect
 *   - NVENC → libx264 fallback on hardware failure
 *   - Detect segment readiness before signalling "ready" to client
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { makeLogger } = require('./logger');

const log = makeLogger('HLS');

// sessionId → session object
const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Return sorted list of .ts files in a directory (empty array on error). */
function listSegments(dir) {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.ts')).sort();
    } catch (_) {
        return [];
    }
}

/** Delete all .ts files in a directory (non-fatal). */
function clearSegments(dir) {
    try {
        listSegments(dir).forEach(f => {
            try { fs.unlinkSync(path.join(dir, f)); } catch (_) { }
        });
    } catch (_) { }
}

/** Delete an HLS session directory (non-fatal). */
function removeDir(dir) {
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { }
}

// ─────────────────────────────────────────────────────────────────────────────
// FFprobe duration
// ─────────────────────────────────────────────────────────────────────────────


/**
 * Probe file duration via ffprobe.
 * timeoutMs: how long to wait before giving up (default 20s).
 * Returns 0 on failure — callers must handle the 0 case gracefully.
 */
function probeDurationFast(streamUrl, timeoutMs = 20_000) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            streamUrl,
        ];
        const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', d => { out += d; });
        proc.on('close', () => resolve(parseFloat(out.trim()) || 0));
        proc.on('error', () => resolve(0));
        const timer = setTimeout(() => {
            try { proc.kill(); } catch (_) { }
            resolve(0);
        }, timeoutMs);
        proc.on('close', () => clearTimeout(timer));
    });
}

/**
 * Update an EVENT playlist in-place with currently available .ts segments.
 * Called once segments exist so Safari/iOS gets a playable playlist immediately.
 */
function _updateEventPlaylist(session) {
    const segs = listSegments(session.outputDir);
    if (!segs.length) return;
    let m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${session.segSec}\n`;
    m3u8 += '#EXT-X-PLAYLIST-TYPE:EVENT\n\n';
    segs.forEach(seg => { m3u8 += `#EXTINF:${session.segSec}.000000,\n${seg}\n`; });
    try { fs.writeFileSync(session.playlistPath, m3u8); } catch (_) { }
}


// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg process management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build ffmpeg args for a given session.
 * encoder: 'h264_nvenc' | 'libx264'
 * startSegment: integer segment index to begin numbering from
 * startTime: float seconds to seek to in the source
 */
function buildFfmpegArgs(outputDir, rawStreamUrl, encoder, startSegment, startTime, segSec) {
    return [
        '-reconnect', '1', '-reconnect_at_eof', '0',
        '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        ...(startTime > 0 ? ['-ss', startTime.toFixed(3)] : []),
        '-i', rawStreamUrl,
        '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', encoder,
        ...(encoder === 'h264_nvenc'
            ? ['-preset', 'p4', '-cq', '23']
            : ['-preset', 'veryfast', '-crf', '23']),
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high', '-level', '4.1',
        '-g', '48', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-f', 'segment',
        '-segment_time', String(segSec),
        '-segment_list_size', '0',
        '-segment_format', 'mpegts',
        '-segment_start_number', String(startSegment),
        path.join(outputDir, 'seg%05d.ts'),
    ];
}

/**
 * Spawn an ffmpeg process for the given session.
 * myGen: the seekGen at the time of spawn. Process ignores its close event
 *        if session.seekGen has advanced (i.e. a newer seek replaced it).
 */
function spawnFfmpeg(sessionId, encoder, startSegment, startTime, myGen) {
    const s = sessions.get(sessionId);
    if (!s) return null;

    const args = buildFfmpegArgs(
        s.outputDir, s.rawStreamUrl, encoder, startSegment, startTime, s.segSec
    );

    const shortId = sessionId.substring(0, 8);
    log.info(`FFmpeg spawn [${shortId}] encoder=${encoder} seg=${startSegment} t=${startTime.toFixed(1)}s`);

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrLines = [];

    proc.stderr.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        lines.forEach(line => {
            if (!line.trim()) return;
            stderrLines.push(line);
            if (stderrLines.length > 60) stderrLines.shift();
            if (line.includes('frame=')) {
                process.stdout.write(`[HLS/${shortId}] ${line.trim()}\n`);
            }
        });
    });

    proc.on('error', err => {
        log.error(`FFmpeg spawn error [${shortId}]: ${err.message}`);
    });

    proc.on('close', code => {
        const current = sessions.get(sessionId);
        // Ignore if session is gone or a newer seek has superseded this process
        if (!current || current.seekGen !== myGen) return;

        if (code !== 0) {
            const segCount = listSegments(s.outputDir).length;
            if (segCount === 0) {
                log.error(`FFmpeg exited with code ${code} and 0 segments [${shortId}]`);
                log.error(`Last stderr:\n${stderrLines.slice(-15).join('\n')}`);

                // NVENC failed with no output → fall back to software encoding
                if (encoder === 'h264_nvenc') {
                    log.warn(`NVENC failed — retrying with libx264 [${shortId}]`);
                    const fb = spawnFfmpeg(sessionId, 'libx264', startSegment, startTime, myGen);
                    if (fb && current) current.ffmpegProc = fb;
                    return;
                }
                if (current) current.status = 'failed';
            }
        } else {
            if (current) current.status = 'complete';
            log.info(`FFmpeg complete [${shortId}]`);
        }
    });

    return proc;
}

// ─────────────────────────────────────────────────────────────────────────────
// VOD playlist pre-write
// ─────────────────────────────────────────────────────────────────────────────

function writeVodPlaylist(filePath, totalDuration, segSec) {
    const numSegments = Math.ceil(totalDuration / segSec);
    if (numSegments === 0) return false;

    let m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${segSec}\n`;
    m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n\n';

    for (let i = 0; i < numSegments; i++) {
        const isLast = (i === numSegments - 1);
        const dur = isLast
            ? (totalDuration - (numSegments - 1) * segSec).toFixed(6)
            : `${segSec}.000000`;
        m3u8 += `#EXTINF:${dur},\nseg${String(i).padStart(5, '0')}.ts\n`;
    }
    m3u8 += '#EXT-X-ENDLIST\n';

    fs.writeFileSync(filePath, m3u8);
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wait for FFmpeg to produce readiness segments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll outputDir until at least `minSegments` .ts files exist,
 * or until timeoutMs elapses.
 * Returns true if ready, false if timed out.
 */
function waitForSegments(outputDir, minSegments, timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        function check() {
            const segs = listSegments(outputDir);
            if (segs.length >= minSegments) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(check, 500);
        }
        check();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup scheduling
// ─────────────────────────────────────────────────────────────────────────────

function scheduleCleanup(sessionId, delayMs) {
    const s = sessions.get(sessionId);
    if (!s) return;
    clearTimeout(s.cleanupTimer);
    s.cleanupTimer = setTimeout(() => {
        log.info(`Cleanup timer fired, destroying session ${sessionId.substring(0, 8)}`);
        destroySession(sessionId);
    }, delayMs);
}

function destroySession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;

    clearTimeout(s.cleanupTimer);

    // Kill FFmpeg
    if (s.ffmpegProc) {
        try { s.ffmpegProc.kill('SIGTERM'); } catch (_) { }
        setTimeout(() => {
            if (s.ffmpegProc) {
                try { s.ffmpegProc.kill('SIGKILL'); } catch (_) { }
            }
        }, 2000);
        s.ffmpegProc = null;
    }

    removeDir(s.outputDir);
    sessions.delete(sessionId);
    log.info(`Session destroyed: ${sessionId.substring(0, 8)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new HLS transcode session.
 * Waits for FFmpeg to produce `config.hlsReadySegments` segments before resolving.
 *
 * @param {{ magnet: string, codec?: string, resolution?: string, infoData?: object }} opts
 *   infoData — optional response from /info endpoint (has .name, .size, .extension)
 * @param {string} rawStreamUrl  — e.g. http://streamer:6987/stream?magnet=...
 * @returns {Promise<{ sessionId, playlistUrl, status, duration }>}
 */
async function createSession(opts, rawStreamUrl) {
    const { magnet, resolution, infoData } = opts;
    const sessionId = uuidv4();
    const outputDir = path.join(config.hlsOutputBase, sessionId);
    const segSec = config.hlsSegmentSec;
    const shortId = sessionId.substring(0, 8);

    ensureDir(config.hlsOutputBase);
    ensureDir(outputDir);
    log.info(`Session created: ${shortId} — ${rawStreamUrl.substring(0, 80)}`);

    // ── Duration probe ──────────────────────────────────────────────────────────
    // Probing the live /stream URL is unreliable: the WebTorrent stream takes
    // 12s+ to start responding, so ffprobe almost always returns 0.
    //
    // Strategy:
    //  1. If /info already gave us the file path (future enhancement), probe that.
    //  2. Otherwise probe the rawStreamUrl but with a short 20s timeout.
    //     If that fails (returns 0), proceed without duration — use EVENT playlist.
    let totalDuration = 0;

    if (infoData && infoData.duration && infoData.duration > 0) {
        // /info explicitly provided duration
        totalDuration = infoData.duration;
        log.info(`Duration from /info [${shortId}]: ${totalDuration.toFixed(1)}s`);
    } else {
        // Probe with a short timeout — if stream isn't ready yet, we get 0 quickly
        // rather than blocking for 60s
        log.info(`Probing duration [${shortId}]…`);
        totalDuration = await probeDurationFast(rawStreamUrl, 20_000);
        log.info(`Duration [${shortId}]: ${totalDuration.toFixed(1)}s`);
    }

    // ── Pre-write VOD playlist if duration is known ─────────────────────────────
    const playlistPath = path.join(outputDir, 'index.m3u8');
    if (totalDuration > 0) {
        writeVodPlaylist(playlistPath, totalDuration, segSec);
        log.info(`VOD playlist pre-written [${shortId}]: ${Math.ceil(totalDuration / segSec)} segments`);
    } else {
        // Write a minimal live EVENT playlist so Safari/iOS gets something immediately
        log.info(`Duration unknown [${shortId}] — will serve EVENT playlist`);
        const eventM3u8 = [
            '#EXTM3U', '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${segSec}`,
            '#EXT-X-PLAYLIST-TYPE:EVENT', '',
        ].join('\n');
        fs.writeFileSync(playlistPath, eventM3u8);
    }

    const session = {
        sessionId, outputDir, playlistPath,
        rawStreamUrl, magnet,
        status: 'transcoding',
        codec: 'h264_nvenc',
        resolution: resolution || 'unknown',
        startTime: Date.now(),
        cleanupTimer: null,
        totalDuration, segSec,
        seekGen: 0,
        consumers: 0,
        ffmpegProc: null,
    };
    sessions.set(sessionId, session);

    // Start FFmpeg
    session.ffmpegProc = spawnFfmpeg(sessionId, 'h264_nvenc', 0, 0, 0);

    // Wait for first segment before returning "ready" to the client
    // (1 segment = ~2s of video for immediate playback start)
    const ready = await waitForSegments(
        outputDir,
        config.hlsReadySegments,
        config.hlsReadyTimeoutMs
    );

    if (!ready) {
        log.error(`Timeout waiting for segments [${shortId}] — destroying session`);
        destroySession(sessionId);
        throw new Error('Transcode failed to produce segments within timeout');
    }

    log.info(`Session ready [${shortId}] — ${listSegments(outputDir).length} segment(s) available`);

    // Update EVENT playlist to include the first ready segment
    if (totalDuration === 0) {
        _updateEventPlaylist(session);
    }

    return {
        sessionId,
        playlistUrl: `/api/hls/${sessionId}/index.m3u8`,
        status: 'transcoding',
        duration: totalDuration,
    };
}


/**
 * Seek to a new time position: kill old FFmpeg, delete old .ts files, restart.
 */
function seekSession(sessionId, seekTime) {
    const s = sessions.get(sessionId);
    if (!s) return { error: 'Session not found' };

    const shortId = sessionId.substring(0, 8);
    log.info(`Seek [${shortId}] → ${seekTime.toFixed(1)}s`);

    // Increment seekGen FIRST so the closing old ffmpeg proc ignores its close event
    s.seekGen = (s.seekGen || 0) + 1;
    const myGen = s.seekGen;

    // Kill old FFmpeg
    const old = s.ffmpegProc;
    s.ffmpegProc = null;
    if (old) {
        try { old.kill('SIGTERM'); } catch (_) { }
        setTimeout(() => { try { old.kill('SIGKILL'); } catch (_) { } }, 1500);
    }

    // Clear old .ts segments so hls.js gets fresh data from new position
    clearSegments(s.outputDir);

    const startSegment = Math.max(0, Math.floor(seekTime / s.segSec));
    const actualStart = startSegment * s.segSec;

    s.ffmpegProc = spawnFfmpeg(sessionId, 'h264_nvenc', startSegment, actualStart, myGen);
    s.status = 'transcoding';

    log.info(`Seek restart [${shortId}] seg=${startSegment} t=${actualStart.toFixed(1)}s`);
    return { success: true, startSegment, actualStartTime: actualStart };
}

/**
 * Stop a session: kill FFmpeg immediately, schedule 5-min cleanup.
 */
function stopSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;

    const shortId = sessionId.substring(0, 8);

    if (s.ffmpegProc) {
        try { s.ffmpegProc.kill('SIGTERM'); } catch (_) { }
        setTimeout(() => {
            if (s.ffmpegProc) { try { s.ffmpegProc.kill('SIGKILL'); } catch (_) { } }
        }, 3000);
        s.ffmpegProc = null;
        s.status = 'stopped';
    }

    scheduleCleanup(sessionId, config.hlsCleanupDelayMs);
    log.info(`Session stopped [${shortId}] — cleanup in ${config.hlsCleanupDelayMs / 1000}s`);
}

/**
 * Increment/decrement consumer count.
 * When count drops to 0, schedule cleanup.
 * When count rises above 0, cancel any pending cleanup.
 */
function addConsumer(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.consumers++;
    clearTimeout(s.cleanupTimer);
    s.cleanupTimer = null;
}

function removeConsumer(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.consumers = Math.max(0, s.consumers - 1);
    if (s.consumers === 0 && s.status !== 'stopped') {
        scheduleCleanup(sessionId, config.hlsCleanupDelayMs);
        log.info(`No consumers remain [${sessionId.substring(0, 8)}] — cleanup scheduled`);
    }
}

/**
 * Get the status of a session for the /api/hls/status/:id endpoint.
 */
function getStatus(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return { status: 'not_found' };
    const segsReady = listSegments(s.outputDir).length;
    return {
        status: s.status,
        codec: s.codec,
        resolution: s.resolution,
        segmentsReady: segsReady,
        elapsed: Math.round((Date.now() - s.startTime) / 1000),
        consumers: s.consumers,
        duration: s.totalDuration,
    };
}

/**
 * Get session for low-level access in route handlers.
 */
function getSession(sessionId) {
    return sessions.get(sessionId) || null;
}

/** Returns true if sessionId exists */
function hasSession(sessionId) {
    return sessions.has(sessionId);
}

/** Ensure the HLS base directory exists (call at startup). */
function init() {
    ensureDir(config.hlsOutputBase);
    log.info(`HLS base: ${config.hlsOutputBase}`);
}

module.exports = {
    init,
    createSession,
    seekSession,
    stopSession,
    destroySession,
    addConsumer,
    removeConsumer,
    getStatus,
    getSession,
    hasSession,
    listSegments,
};
