'use strict';
/**
 * Streamer — server.js (bootstrap)
 *
 * Starts the Express HTTP server on Windows.
 * All logic lives in src/.
 */

const express = require('express');
const cors = require('cors');
const config = require('./src/config');
const { makeLogger } = require('./src/logger');
const { runStartupCleanup } = require('./src/storage');
const routes = require('./src/routes');

const log = makeLogger('Streamer');
const app = express();

app.use(cors());
app.use(routes);

const server = app.listen(config.port, () => {
    log.info('====================================================');
    log.info(`WebTorrent Streamer running on port ${config.port}`);
    log.info(`Default path  : ${config.defaultDlPath || '(WebTorrent default)'}`);
    log.info(`Fallback path : ${config.fallbackDlPath}`);
    log.info(`Large file    : >${config.largeFileTHresholdGb} GB uses fallback`);
    log.info(`Max torrents  : ${config.maxActiveTorrents}`);
    log.info(`Cleanup delay : ${config.cleanupDelayMs / 1000}s`);
    log.info('====================================================');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log.error(`Port ${config.port} already in use — exiting so start.bat can retry`);
        process.exit(1);
    }
    log.error(`Server error: ${err.message}`);
});

// Startup cleanup (5s delay to avoid blocking initial boot)
setTimeout(runStartupCleanup, 5000);
