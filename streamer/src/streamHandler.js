import fs from 'fs';
import path from 'path';
import { makeLogger } from './logger.js';

const log = makeLogger('Stream');

const MIME = {
    mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska',
    webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime',
    ts: 'video/MP2T', m2ts: 'video/MP2T', mpeg: 'video/mpeg', mpg: 'video/mpeg',
};

function getMime(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    return MIME[ext] || 'application/octet-stream';
}

function parseRange(rangeHeader, total) {
    if (!rangeHeader) return { start: 0, end: total - 1 };
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) return { start: 0, end: total - 1 };
    let start = match[1] !== '' ? parseInt(match[1], 10) : 0;
    let end = match[2] !== '' ? parseInt(match[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) end = total - 1;
    return { start, end };
}

function writeHeaders(res, start, end, total, mimeType) {
    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
    });
}

export function serveFromDisk(filePath, req, res) {
    try {
        const total = fs.statSync(filePath).size;
        const mimeType = getMime(filePath);
        const { start, end } = parseRange(req.headers.range, total);

        if (start >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            return res.end();
        }

        log.info(`Disk serve: ${path.basename(filePath)} bytes ${start}-${end}`);
        writeHeaders(res, start, end, total, mimeType);
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', (err) => log.warn(`Disk stream error: ${err.message}`));
        res.on('error', () => { });
        req.on('close', () => stream.destroy());
        stream.pipe(res);
    } catch (err) {
        log.error(`serveFromDisk error: ${err.message}`);
        if (!res.headersSent) res.status(500).send('File serve error');
    }
}

export function serveFromTorrent(file, req, res, onClose) {
    const total = file.length;
    const mimeType = getMime(file.name);
    const { start, end } = parseRange(req.headers.range, total);

    if (start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
    }

    log.info(`Torrent serve: ${file.name} (${(total / 1e9).toFixed(2)} GB) bytes ${start}-${end}`);
    writeHeaders(res, start, end, total, mimeType);

    try { file.select(); } catch (_) { }

    const stream = file.createReadStream({ start, end });
    stream.on('error', (err) => {
        if (err.message && err.message.includes('premature')) return;
        log.warn(`Torrent stream error: ${err.message}`);
    });
    res.on('error', () => { });
    stream.pipe(res);
    req.on('close', () => {
        stream.destroy();
        if (typeof onClose === 'function') onClose();
    });
}
