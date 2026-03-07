import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import config from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('Storage');

const VIDEO_EXTS_RE = /\.(mp4|m4v|mkv|webm|avi|ts|mov|m2ts|mpeg|mpg)$/i;

// ── Disk free space (Windows) ─────────────────────────────────────────────────
export function getDiskFreeBytes(drivePath) {
    try {
        const drive = path.parse(drivePath).root.replace(/\\/g, '');
        const result = execSync(
            `wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`,
            { encoding: 'utf8', timeout: 5000 }
        );
        const match = result.match(/FreeSpace=(\d+)/);
        if (match) return parseInt(match[1], 10);
    } catch (e) {
        log.warn(`getDiskFreeBytes failed for ${drivePath}: ${e.message}`);
    }
    return Infinity;
}

// ── Download path selection ────────────────────────────────────────────────────
export function pickDownloadPath(fileSizeBytes = 0) {
    const { defaultDlPath, fallbackDlPath, largeFileTHresholdGb } = config;

    if (!defaultDlPath && !fallbackDlPath) return undefined;

    const thresholdBytes = largeFileTHresholdGb * 1024 * 1024 * 1024;

    if (defaultDlPath && (fileSizeBytes === 0 || fileSizeBytes <= thresholdBytes)) {
        const freeBytes = getDiskFreeBytes(defaultDlPath);
        const needed = fileSizeBytes > 0 ? fileSizeBytes * 1.1 : 0;
        if (freeBytes > needed) return defaultDlPath;
        log.warn(`Default path low on space (${(freeBytes / 1e9).toFixed(1)} GB free) — using fallback`);
    }

    if (fallbackDlPath) {
        if (!fs.existsSync(fallbackDlPath)) fs.mkdirSync(fallbackDlPath, { recursive: true });
        log.info(`Using fallback path: ${fallbackDlPath}`);
        return fallbackDlPath;
    }

    return undefined;
}

// ── Existing file lookup ──────────────────────────────────────────────────────
export function findExistingFile(magnetURI) {
    const searchDirs = [config.defaultDlPath, config.fallbackDlPath].filter(Boolean);
    if (!searchDirs.length) return null;

    let torrentName = null;
    try {
        const dn = new URLSearchParams(magnetURI.replace(/^magnet:\?/i, '')).get('dn');
        torrentName = dn ? decodeURIComponent(dn) : null;
    } catch (_) { }

    if (!torrentName) return null;

    for (const baseDir of searchDirs) {
        if (!fs.existsSync(baseDir)) continue;
        try {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const entry of entries) {
                const nameMatch = entry.name === torrentName;

                if (entry.isDirectory() && nameMatch) {
                    const videoFile = findLargestVideoIn(path.join(baseDir, entry.name));
                    if (videoFile) { log.info(`Found existing file in dir: ${videoFile}`); return videoFile; }
                }

                if (entry.isFile() && nameMatch && VIDEO_EXTS_RE.test(entry.name)) {
                    const fPath = path.join(baseDir, entry.name);
                    if (fs.statSync(fPath).size > 10 * 1024 * 1024) {
                        log.info(`Found existing single file: ${fPath}`);
                        return fPath;
                    }
                }
            }
        } catch (e) {
            log.warn(`findExistingFile scan error in ${baseDir}: ${e.message}`);
        }
    }
    return null;
}

function findLargestVideoIn(dir) {
    try {
        return fs.readdirSync(dir)
            .filter(f => VIDEO_EXTS_RE.test(f))
            .map(f => { const fp = path.join(dir, f); return { path: fp, size: fs.statSync(fp).size }; })
            .filter(f => f.size > 10 * 1024 * 1024)
            .sort((a, b) => b.size - a.size)[0]?.path || null;
    } catch (_) { return null; }
}

// ── Startup cleanup ────────────────────────────────────────────────────────────
export function runStartupCleanup() {
    const dirs = [config.defaultDlPath, config.fallbackDlPath].filter(Boolean);
    const cutoff = Date.now() - config.startupCleanupAgeHours * 60 * 60 * 1000;

    for (const baseDir of dirs) {
        if (!fs.existsSync(baseDir)) continue;
        try {
            fs.readdirSync(baseDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .forEach(e => {
                    try {
                        const fullPath = path.join(baseDir, e.name);
                        if (fs.statSync(fullPath).mtimeMs < cutoff) {
                            fs.rmSync(fullPath, { recursive: true, force: true });
                            log.info(`Startup cleanup removed: ${fullPath}`);
                        }
                    } catch (_) { }
                });
        } catch (_) { }
    }
}
