'use strict';
/**
 * Hub — server.js (bootstrap)
 *
 * Mounts all route modules and starts the HTTP + Socket.IO server.
 * This file is intentionally minimal — all logic lives in src/.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const config = require('./src/config');
const { makeLogger } = require('./src/logger');
const hls = require('./src/hlsManager');

const apiRoutes = require('./src/routes/api');
const hlsRoutes = require('./src/routes/hls');
const probeRoutes = require('./src/routes/probe');
const streamRoutes = require('./src/routes/stream');
const historyRoutes = require('./src/routes/history');
const statusRoutes = require('./src/routes/status');

const log = makeLogger('Hub');
const app = express();

app.use(cors());
app.use(express.json());

// ─── Static frontend ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);
app.use('/api/hls', hlsRoutes);
app.use('/api/probe', probeRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api', historyRoutes);
app.use('/api', statusRoutes);

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── HTTP + Socket.IO ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Active stream tracking for admin panel (Socket.IO)
const activeStreams = {};

io.on('connection', (socket) => {
    socket.on('start_stream', (data) => {
        let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        if (ip.includes(',')) ip = ip.split(',')[0].trim();
        activeStreams[socket.id] = { ...data, ip, startTime: Date.now(), socketId: socket.id, progress: 0 };
        io.emit('active_streams', Object.values(activeStreams));
        log.info(`Stream started: ${data.user_id} — ${data.title} (${ip})`);
    });

    socket.on('update_progress', (data) => {
        if (activeStreams[socket.id]) {
            activeStreams[socket.id].progress = data.progress;
            io.emit('active_streams', Object.values(activeStreams));
        }
    });

    socket.on('update_transcode', (data) => {
        if (activeStreams[socket.id]) {
            Object.assign(activeStreams[socket.id], {
                transcoding: data.transcoding,
                codec: data.codec,
                resolution: data.resolution,
                sessionId: data.sessionId,
            });
            io.emit('active_streams', Object.values(activeStreams));
        }
    });

    socket.on('admin_action', (data) => {
        if (data.socketId && data.action) {
            io.to(data.socketId).emit('remote_action', { action: data.action });
        }
    });

    socket.on('stop_stream', () => {
        const s = activeStreams[socket.id];
        if (s) log.info(`Stream stopped: ${s.user_id} — ${s.title}`);
        delete activeStreams[socket.id];
        io.emit('active_streams', Object.values(activeStreams));
    });

    socket.on('disconnect', () => {
        delete activeStreams[socket.id];
        io.emit('active_streams', Object.values(activeStreams));
    });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
hls.init();

server.listen(config.port, () => {
    log.info('====================================================');
    log.info(`StreamHub running on port ${config.port}`);
    log.info(`Streamer URL : ${config.streamerUrl}`);
    log.info(`HLS base     : ${config.hlsOutputBase}`);
    log.info('====================================================');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log.error(`Port ${config.port} already in use — exiting`);
        process.exit(1);
    }
    log.error(`Server error: ${err.message}`);
});
