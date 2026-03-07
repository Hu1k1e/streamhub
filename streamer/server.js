// ESM bootstrap for the Streamer
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import config from './src/config.js';
import { makeLogger } from './src/logger.js';
import { runStartupCleanup } from './src/storage.js';
import routes from './src/routes.js';

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
        log.error(`Port ${config.port} already in use — exiting`);
        process.exit(1);
    }
    log.error(`Server error: ${err.message}`);
});

// Startup cleanup (5s delay to avoid blocking boot)
setTimeout(runStartupCleanup, 5000);
