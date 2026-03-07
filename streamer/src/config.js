// ESM — loaded with "type":"module" in package.json
import 'dotenv/config';

function optional(name, def = null) { return process.env[name] || def; }
function optionalInt(name, def) { const v = process.env[name]; return v ? parseInt(v, 10) : def; }
function optionalFloat(name, def) { const v = process.env[name]; return v ? parseFloat(v) : def; }

const config = {
    port: optionalInt('PORT', 6987),

    // WebTorrent
    maxConns: optionalInt('MAX_CONNS', 30),
    dhtPort: optionalInt('DHT_PORT', 6988),
    torrentPort: optionalInt('TORRENT_PORT', 6989),
    maxActiveTorrents: optionalInt('MAX_ACTIVE_TORRENTS', 5),
    idleResetMinutes: optionalInt('IDLE_RESET_MINUTES', 15),
    clientMaxErrors: optionalInt('CLIENT_MAX_ERRORS', 3),

    // Storage
    defaultDlPath: optional('DEFAULT_DL_PATH', null),
    fallbackDlPath: optional('FALLBACK_DL_PATH', 'D:\\TempMovies'),
    largeFileTHresholdGb: optionalFloat('LARGE_FILE_THRESHOLD_GB', 20),

    // Cleanup
    cleanupDelayMs: optionalInt('CLEANUP_DELAY_MS', 5 * 60 * 1000),
    startupCleanupAgeHours: optionalFloat('STARTUP_CLEANUP_AGE_HOURS', 12),
};

export default config;
