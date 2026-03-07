'use strict';
/**
 * routes/history.js — Watch history (SQLite-backed)
 *
 * GET    /api/history/:userId        — user watch history
 * POST   /api/history                — record a watch event
 * GET    /api/admin/history          — all users (admin)
 * DELETE /api/admin/history          — wipe all history (admin)
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { makeLogger } = require('../logger');

const log = makeLogger('History');
const router = express.Router();

// ── Database setup ─────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DATA_DIR, 'history.db'), (err) => {
    if (err) log.error(`DB open error: ${err.message}`);
    else log.info('SQLite history DB ready');
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT NOT NULL,
            tmdb_id    TEXT NOT NULL,
            media_type TEXT NOT NULL,
            title      TEXT NOT NULL,
            poster_path TEXT,
            watched_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// ── Routes ─────────────────────────────────────────────────────────────────────
router.get('/admin/history', (req, res) => {
    db.all('SELECT * FROM history ORDER BY watched_at DESC LIMIT 200', [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json(rows);
    });
});

router.delete('/admin/history', (req, res) => {
    db.run('DELETE FROM history', function (err) {
        if (err) return res.status(500).json({ error: 'DB error' });
        log.info('Watch history wiped by admin');
        res.json({ success: true });
    });
});

router.get('/history/:userId', (req, res) => {
    db.all(
        'SELECT * FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 50',
        [req.params.userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json(rows);
        }
    );
});

router.post('/history', (req, res) => {
    const { user_id, tmdb_id, media_type, title, poster_path } = req.body;
    if (!user_id || !tmdb_id || !title || !media_type) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    db.serialize(() => {
        // Upsert: remove old entry for same user + title, insert fresh with current timestamp
        db.run('DELETE FROM history WHERE user_id = ? AND tmdb_id = ?', [user_id, tmdb_id]);
        db.run(
            'INSERT INTO history (user_id, tmdb_id, media_type, title, poster_path) VALUES (?, ?, ?, ?, ?)',
            [user_id, tmdb_id, media_type, title, poster_path],
            function (err) {
                if (err) return res.status(500).json({ error: 'DB error' });
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

module.exports = router;
