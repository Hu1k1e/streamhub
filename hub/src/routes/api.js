'use strict';
/**
 * routes/api.js — External service API proxies
 *
 * GET  /api/search           — TMDB multi search
 * GET  /api/movie/:id        — TMDB movie details
 * GET  /api/tv/:id           — TMDB TV details
 * GET  /api/tv/:id/season/:n — TMDB season details
 * GET  /api/trending         — TMDB trending movies (pills)
 * GET  /api/grid             — TMDB popular posters (grid)
 * GET  /api/torrents         — Prowlarr torrent search
 * POST /api/login            — Jellyfin auth
 * GET  /api/jellyfin/check   — check if title is in Jellyfin library
 * GET  /api/jellyseerr/options — Jellyseerr radarr/sonarr config
 * POST /api/jellyseerr/request — Submit media request to Jellyseerr
 * GET  /api/get-magnet       — Resolve .torrent URL to magnet
 */

const express = require('express');
const axios = require('axios');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('API');
const router = express.Router();

// ── TMDB ─────────────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    try {
        const r = await axios.get('https://api.themoviedb.org/3/search/multi', {
            params: { api_key: config.tmdbApiKey, query: q, include_adult: false },
        });
        res.json(r.data.results.filter(m => m.poster_path && (m.media_type === 'movie' || m.media_type === 'tv')));
    } catch (e) {
        log.error(`TMDB search failed: ${e.message}`);
        res.status(500).json({ error: 'TMDB search failed' });
    }
});

router.get('/movie/:id', async (req, res) => {
    try {
        const r = await axios.get(`https://api.themoviedb.org/3/movie/${req.params.id}`, {
            params: { api_key: config.tmdbApiKey },
        });
        res.json(r.data);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch movie' }); }
});

router.get('/tv/:id', async (req, res) => {
    try {
        const r = await axios.get(`https://api.themoviedb.org/3/tv/${req.params.id}`, {
            params: { api_key: config.tmdbApiKey },
        });
        res.json(r.data);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch TV show' }); }
});

router.get('/tv/:id/season/:season_number', async (req, res) => {
    try {
        const r = await axios.get(
            `https://api.themoviedb.org/3/tv/${req.params.id}/season/${req.params.season_number}`,
            { params: { api_key: config.tmdbApiKey } }
        );
        res.json(r.data);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch season' }); }
});

router.get('/trending', async (req, res) => {
    try {
        const r = await axios.get('https://api.themoviedb.org/3/trending/movie/day', {
            params: { api_key: config.tmdbApiKey },
        });
        res.json(r.data.results.slice(0, 10).map(m => ({ id: m.id, title: m.title })));
    } catch (e) { res.status(500).json({ error: 'Failed to fetch trending' }); }
});

router.get('/grid', async (req, res) => {
    try {
        const page = Math.floor(Math.random() * 5) + 1;
        const r = await axios.get('https://api.themoviedb.org/3/movie/popular', {
            params: { api_key: config.tmdbApiKey, page },
        });
        res.json(
            r.data.results
                .filter(m => m.poster_path)
                .slice(0, 18)
                .map(m => `https://image.tmdb.org/t/p/w200${m.poster_path}`)
        );
    } catch (e) { res.status(500).json({ error: 'Failed to fetch grid' }); }
});

// ── Prowlarr ──────────────────────────────────────────────────────────────────
router.get('/torrents', async (req, res) => {
    const { q, year } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    try {
        const r = await axios.get(`${config.prowlarrUrl}/api/v1/search`, {
            headers: { 'X-Api-Key': config.prowlarrApiKey },
            params: { query: `${q} ${year || ''}`.trim(), type: 'search', limit: 100 },
        });
        res.json(
            r.data
                .filter(t => t.magnetUrl || t.downloadUrl)
                .map(t => ({
                    title: t.title,
                    size: t.size,
                    seeders: t.seeders,
                    leechers: t.leechers,
                    indexer: t.indexer,
                    magnetUrl: t.magnetUrl || t.downloadUrl,
                }))
                .sort((a, b) => b.seeders - a.seeders)
        );
    } catch (e) {
        log.error(`Prowlarr search failed: ${e.message}`);
        res.status(500).json({ error: 'Prowlarr search failed' });
    }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
    const jfUrl = config.jellyfinUrl.replace(/\/$/, '');
    try {
        const r = await axios.post(
            `${jfUrl}/Users/AuthenticateByName`,
            { Username: username, Pw: password },
            {
                headers: {
                    Authorization: 'MediaBrowser Client="StreamHub", Device="Web", DeviceId="123", Version="1.0.0"',
                    'Content-Type': 'application/json',
                },
            }
        );
        res.json({ success: true, user: r.data.User, token: r.data.AccessToken });
    } catch (e) {
        log.warn(`Login failed for user: ${username}`);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// ── Jellyfin library check ────────────────────────────────────────────────────
router.get('/jellyfin/check', async (req, res) => {
    const { title, tmdbId } = req.query;
    if (!title || !config.jellyfinApiKey) return res.json({ exists: false });
    try {
        const jfUrl = config.jellyfinUrl.replace(/\/$/, '');
        const jfExtUrl = (config.jellyfinExtUrl || jfUrl).replace(/\/$/, '');
        const r = await axios.get(
            `${jfUrl}/Items?IncludeItemTypes=Movie,Series&Recursive=true&searchTerm=${encodeURIComponent(title)}&Fields=ProviderIds`,
            { headers: { 'X-Emby-Token': config.jellyfinApiKey } }
        );
        let match = null;
        if (r.data.Items?.length) {
            if (tmdbId) match = r.data.Items.find(i => i.ProviderIds?.Tmdb === tmdbId.toString());
            if (!match) match = r.data.Items.find(i => i.Name.toLowerCase() === title.toLowerCase());
        }
        if (match) return res.json({ exists: true, id: match.Id, url: `${jfExtUrl}/web/index.html#!/details?id=${match.Id}` });
        res.json({ exists: false });
    } catch (e) {
        log.error(`Jellyfin check failed: ${e.message}`);
        res.status(500).json({ error: 'Jellyfin check failed' });
    }
});

// ── Jellyseerr ────────────────────────────────────────────────────────────────
router.get('/jellyseerr/options', async (req, res) => {
    if (!config.jellyseerrApiKey || !config.jellyseerrUrl) return res.json({ configured: false });
    try {
        const base = config.jellyseerrUrl.replace(/\/$/, '') + '/api/v1';
        const key = config.jellyseerrApiKey;
        const [rr, sr] = await Promise.all([
            axios.get(`${base}/settings/radarr`, { headers: { 'X-Api-Key': key } }).catch(() => ({ data: [] })),
            axios.get(`${base}/settings/sonarr`, { headers: { 'X-Api-Key': key } }).catch(() => ({ data: [] })),
        ]);
        const radarr = rr.data[0] || null;
        const sonarr = sr.data[0] || null;
        if (radarr) {
            try {
                const t = await axios.post(`${base}/settings/radarr/test`, radarr, { headers: { 'X-Api-Key': key } });
                radarr.profiles = t.data.profiles || []; radarr.rootFolders = t.data.rootFolders || [];
            } catch { radarr.profiles = []; radarr.rootFolders = []; }
        }
        if (sonarr) {
            try {
                const t = await axios.post(`${base}/settings/sonarr/test`, sonarr, { headers: { 'X-Api-Key': key } });
                sonarr.profiles = t.data.profiles || []; sonarr.rootFolders = t.data.rootFolders || [];
            } catch { sonarr.profiles = []; sonarr.rootFolders = []; }
        }
        res.json({ configured: true, radarr, sonarr });
    } catch (e) {
        log.error(`Jellyseerr options failed: ${e.message}`);
        res.status(500).json({ error: 'Jellyseerr options failed' });
    }
});

router.post('/jellyseerr/request', async (req, res) => {
    if (!config.jellyseerrApiKey || !config.jellyseerrUrl) return res.status(500).json({ error: 'Not configured' });
    try {
        const base = config.jellyseerrUrl.replace(/\/$/, '') + '/api/v1';
        const key = config.jellyseerrApiKey;
        const { mediaId, mediaType, serverId, profileId, rootFolder, requestUser } = req.body;

        let userId = 1;
        if (requestUser) {
            try {
                const uRes = await axios.get(`${base}/user`, { headers: { 'X-Api-Key': key } });
                const rLower = requestUser.toLowerCase();
                const m = (uRes.data?.results || []).find(u =>
                    u.username?.toLowerCase() === rLower ||
                    u.displayName?.toLowerCase() === rLower ||
                    u.email?.toLowerCase().includes(rLower)
                );
                if (m) userId = m.id;
            } catch (_) { }
        }

        const payload = { mediaId, mediaType, userId };
        if (serverId !== undefined) payload.serverId = serverId;
        if (profileId !== undefined) payload.profileId = profileId;
        if (rootFolder !== undefined) payload.rootFolder = rootFolder;

        const r = await axios.post(`${base}/request`, payload, { headers: { 'X-Api-Key': key } });
        res.json({ success: true, data: r.data });
    } catch (e) {
        log.error(`Jellyseerr request failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.response?.data?.message || 'Jellyseerr request failed' });
    }
});

// ── Magnet resolution ─────────────────────────────────────────────────────────
router.get('/get-magnet', async (req, res) => {
    const torrentUrl = req.query.url;
    if (!torrentUrl) return res.status(400).json({ error: 'URL required' });
    try {
        if (torrentUrl.startsWith('magnet:')) return res.json({ magnetUrl: torrentUrl });
        const r = await axios.get(torrentUrl, {
            headers: { 'X-Api-Key': config.prowlarrApiKey },
            responseType: 'arraybuffer',
            maxRedirects: 0,
        });
        const pt = await import('parse-torrent');
        const parsed = await pt.default(Buffer.from(r.data));
        res.json({ magnetUrl: pt.toMagnetURI(parsed) });
    } catch (e) {
        if (e.response?.status >= 300 && e.response?.status < 400) {
            const loc = e.response.headers.location || e.response.headers.Location;
            if (loc?.startsWith('magnet:')) return res.json({ magnetUrl: loc });
        }
        log.error(`get-magnet failed: ${e.message}`);
        res.status(500).json({ error: 'Failed to parse magnet' });
    }
});

module.exports = router;
