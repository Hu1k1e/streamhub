'use strict';
require('dotenv').config();

function required(name) {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
}

function optional(name, defaultValue = null) {
    return process.env[name] || defaultValue;
}

const config = {
    port: parseInt(optional('PORT', '3000'), 10),

    // External services
    tmdbApiKey: required('TMDB_API_KEY'),
    prowlarrUrl: required('PROWLARR_URL'),
    prowlarrApiKey: required('PROWLARR_API_KEY'),
    streamerUrl: optional('STREAMER_URL', 'http://localhost:6987'),
    jellyfinUrl: optional('JELLYFIN_URL', 'http://localhost:8096'),
    jellyfinExtUrl: optional('JELLYFIN_EXTERNAL_URL', null),
    jellyfinApiKey: optional('JELLYFIN_API_KEY', null),
    jellyseerrUrl: optional('JELLYSEERR_URL', null),
    jellyseerrApiKey: optional('JELLYSEERR_API_KEY', null),

    // HLS transcoding
    hlsOutputBase: optional('HLS_OUTPUT_BASE', '/tmp/hls_sessions'),
    hlsSegmentSec: parseInt(optional('HLS_SEGMENT_SEC', '2'), 10),
    hlsReadySegments: parseInt(optional('HLS_READY_SEGMENTS', '2'), 10),  // min segs before ready
    hlsReadyTimeoutMs: parseInt(optional('HLS_READY_TIMEOUT_MS', '90000'), 10),

    // Warmup: streamer /info retry config
    streamerWarmupMaxRetries: parseInt(optional('STREAMER_WARMUP_MAX_RETRIES', '10'), 10),
    streamerWarmupTimeoutMs: parseInt(optional('STREAMER_WARMUP_TIMEOUT_MS', '90000'), 10),
    streamerWarmupRetryBase: parseInt(optional('STREAMER_WARMUP_RETRY_BASE_MS', '1000'), 10),

    // HLS session cleanup
    hlsCleanupDelayMs: parseInt(optional('HLS_CLEANUP_DELAY_MS', String(5 * 60 * 1000)), 10),
};

module.exports = config;
