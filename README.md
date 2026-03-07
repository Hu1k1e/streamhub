# StreamHub 🎬

A self-hosted movie streaming app — search, click, and stream directly from torrents via a beautiful web UI. Supports direct play and hardware-transcoded HLS for all devices (including iOS/Safari).

## Features

- **Movie Search** — TMDB-powered search with autocomplete and backdrop art
- **Direct Play** — H.264/AAC content plays instantly in the browser with no transcoding
- **HLS Transcoding** — NVENC (GPU) hardware-accelerated H.265→H.264 transcode for devices that need it (iOS, Safari)
- **Session Resume** — Exiting and re-entering the player within 5 minutes resumes where the transcoder left off
- **Auto-Cleanup** — Streams are automatically killed and wiped 5 minutes after the player closes
- **Startup Cleanup** — Leftover torrent files from crashes are removed on restart
- **Admin Panel** — Real-time active stream monitoring
- **Watch History** — SQLite-backed per-user history

---

## Architecture

```
Browser / Mobile Client
       │  HTTP + WebSocket
       ▼
  Hub (Docker, Ubuntu)    ← ghcr.io/hu1k1e/streamhub:latest
  ├── Express API + Socket.IO
  ├── TMDB / Prowlarr / Jellyfin proxy
  ├── HLS Manager (FFmpeg / NVENC)
  └── Stream Proxy → Streamer
             │ HTTP
             ▼
  Streamer (Node.js, Windows)
  └── WebTorrent — downloads & streams raw bytes
```

---

## Deployment

### Prerequisites

| Requirement | Notes |
|---|---|
| Docker + Compose | On the Ubuntu/Linux Hub machine |
| NVIDIA GPU + drivers | On the Hub (for NVENC transcoding) |
| Node.js v20+ | On the Windows Streamer machine |
| Prowlarr | Torrent indexer |
| TMDB API key | Free at [themoviedb.org](https://www.themoviedb.org) |

### Hub — Docker

1. Copy `docker-compose.example.yml` from this repo to your server and rename it `docker-compose.yml`
2. Fill in your real credentials (TMDB key, Prowlarr URL/key, Jellyfin key, etc.)
3. Deploy:

```bash
docker compose up -d
```

Or import the compose file into Portainer → Stacks → Add Stack.

> **Image:** `ghcr.io/hu1k1e/streamhub:latest` — rebuilt automatically on every push to `main`.

### Hub — Storage

HLS transcoded segments are stored at:

| Variable | Default (inside container) | Volume mapped to |
|---|---|---|
| `HLS_OUTPUT_BASE` | `/hls_temp` | `/tmp/hls_temp` on host |

Sessions are cleaned up 5 minutes after the player closes. Unmapped `/hls_temp` uses container disk space.

### Streamer — Windows Setup

The Streamer runs on a Windows machine and handles WebTorrent downloads.

```powershell
cd streamer
npm install
# Create .env from the example:
copy .env.example .env
# Edit .env with your paths, then:
npm start
```

**Default torrent storage paths:**

| Path | When used |
|---|---|
| `DEFAULT_DL_PATH` (from `.env`) | Normal files — explicitly configured path |
| `FALLBACK_DL_PATH` (default: `D:\TempMovies`) | Files > 20 GB, or when default drive is full |
| `%LOCALAPPDATA%\Temp\webtorrent\` | When `DEFAULT_DL_PATH` is **not** set |

> To free disk space now: delete everything inside `%LOCALAPPDATA%\Temp\webtorrent\`  
> (`C:\Users\<you>\AppData\Local\Temp\webtorrent\`)

Files are automatically deleted 5 minutes after the last viewer disconnects.  
Leftover files from crashes are cleaned on startup (older than 6 hours by default).

---

## Environment Variables

### Hub (`docker-compose.yml`)

| Variable | Required | Description |
|---|---|---|
| `TMDB_API_KEY` | ✅ | TMDB v3 API key |
| `PROWLARR_URL` | ✅ | e.g. `http://192.168.1.10:9696` |
| `PROWLARR_API_KEY` | ✅ | Prowlarr API key |
| `STREAMER_URL` | ✅ | e.g. `http://192.168.1.15:6987` |
| `JELLYFIN_URL` | — | Internal Jellyfin base URL |
| `JELLYFIN_EXTERNAL_URL` | — | External Jellyfin URL (for mobile) |
| `JELLYFIN_API_KEY` | — | Jellyfin API key |
| `HLS_OUTPUT_BASE` | — | Default: `/hls_temp` |
| `HLS_SEGMENT_SEC` | — | Segment duration in seconds (default: `2`) |
| `HLS_READY_SEGMENTS` | — | Segments to wait for before signalling ready (default: `1`) |
| `HLS_CLEANUP_DELAY_MS` | — | Cleanup delay in ms (default: `300000` = 5 min) |

### Streamer (`streamer/.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6987` | Streamer listen port |
| `DEFAULT_DL_PATH` | null | Where to download torrent files |
| `FALLBACK_DL_PATH` | `D:\TempMovies` | Used for large files or when default is full |
| `LARGE_FILE_THRESHOLD_GB` | `20` | Files above this go to fallback |
| `CLEANUP_DELAY_MS` | `300000` | Delete torrent files after 5 min idle |
| `STARTUP_CLEANUP_AGE_HOURS` | `6` | Remove leftovers older than this on startup |

---

## Development

```bash
# Hub
cd hub && npm install && npm run dev

# Streamer
cd streamer && npm install && npm start
```

---

## License

MIT
