'use strict';
/**
 * storage.js — Disk utilities for the Streamer
 *
 * - getDiskFreeBytes(path): how much free space a drive has (Windows WMIC)
 * - pickDownloadPath(fileSizeBytes): choose default or fallback path
 * - findExistingFile(magnetURI): scan download dirs for a pre-existing complete file
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const { makeLogger } = require('./logger');

const log = makeLogger('Storage');

const VIDEO_EXTS_RE = /\.(mp4|m4v|mkv|webm|avi|ts|mov|m2ts|mpeg|mpg)$/i;

// ── Disk free space (Windows only) ────────────────────────────────────────────
function getDiskFreeBytes(drivePath) {
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
    return Infinity; // assume space is available if check fails
}

// ── Download path selection ────────────────────────────────────────────────────
/**
 * Choose the best download directory for a given file size.
 * Falls back to FALLBACK_DL_PATH for large files or when the primary drive is full.
 *
 * @param {number} fileSizeBytes — 0 if not yet known (pre-metadata)
 * @returns {string|undefined}
 */
function pickDownloadPath(fileSizeBytes = 0) {
    const { defaultDlPath, fallbackDlPath, largeFileTHresholdGb } = config;

    if (!defaultDlPath && !fallbackDlPath) return undefined;

    const thresholdBytes = largeFileTHresholdGb * 1024 * 1024 * 1024;

    // Use default path if file is small AND there's enough space
    if (defaultDlPath && (fileSizeBytes === 0 || fileSizeBytes <= thresholdBytes)) {
        const freeBytes = getDiskFreeBytes(defaultDlPath);
        const needed = fileSizeBytes > 0 ? fileSizeBytes * 1.1 : 0;
        if (freeBytes > needed) {
            return defaultDlPath;
        }
        log.warn(`Default path low on space (${(freeBytes / 1e9).toFixed(1)} GB free) — using fallback`);
    }

    // Fallback path
    if (fallbackDlPath) {
        if (!fs.existsSync(fallbackDlPath)) {
            fs.mkdirSync(fallbackDlPath, { recursive: true });
        }
        log.info(`Using fallback path: ${fallbackDlPath}`);
        return fallbackDlPath;
    }

    return undefined;
}

// ── Existing file lookup (fast path for pre-downloads) ────────────────────────
/**
 * Scan download directories for an already-complete video file matching the
 * torrent's dn= name. Returns the absolute file path, or null if not found.
 *
 * NOTE: This is only called when the torrent is NOT currently managed by
 * WebTorrent — to avoid serving partially-written files.
 *
 * @param {string} magnetURI
 * @returns {string|null}
 */
function findExistingFile(magnetURI) {
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

                // Directory match (multi-file torrent)
                if (entry.isDirectory() && nameMatch) {
                    const subDir = path.join(baseDir, entry.name);
                    const videoFile = findLargestVideoIn(subDir);
                    if (videoFile) {
                        log.info(`Found existing file in dir: ${videoFile}`);
                        return videoFile;
                    }
                }

                // Single-file torrent
                if (entry.isFile() && nameMatch && VIDEO_EXTS_RE.test(entry.name)) {
                    const fPath = path.join(baseDir, entry.name);
                    const fSize = fs.statSync(fPath).size;
                    if (fSize > 10 * 1024 * 1024) {
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

/**
 * Find the largest video file > 10MB in a directory (non-recursive).
 * @param {string} dir
 * @returns {string|null}
 */
function findLargestVideoIn(dir) {
    try {
        const candidates = fs.readdirSync(dir)
            .filter(f => VIDEO_EXTS_RE.test(f))
            .map(f => {
                const fp = path.join(dir, f);
                const size = fs.statSync(fp).size;
                return { path: fp, size };
            })
            .filter(f => f.size > 10 * 1024 * 1024)
            .sort((a, b) => b.size - a.size);
        return candidates[0]?.path || null;
    } catch (_) {
        return null;
    }
}

// ── Startup cleanup ────────────────────────────────────────────────────────────
/**
 * Remove download directories older than config.startupCleanupAgeHours.
 * Called once at startup to reclaim disk space from previous sessions.
 */
function runStartupCleanup() {
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
                        const stat = fs.statSync(fullPath);
                        if (stat.mtimeMs < cutoff) {
                            fs.rmSync(fullPath, { recursive: true, force: true });
                            log.info(`Startup cleanup removed: ${fullPath}`);
                        }
                    } catch (_) { }
                });
        } catch (_) { }
    }
}

module.exports = { getDiskFreeBytes, pickDownloadPath, findExistingFile, runStartupCleanup };
