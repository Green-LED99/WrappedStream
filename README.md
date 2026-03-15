# WrappedStream

Stream video and audio to a Discord voice channel via Go Live. Supports direct URLs, movie/TV search (Stremio + Real-Debrid), YouTube, and live sports.

This is a CLI tool designed to be invoked programmatically by an agent or script. It takes a command, resolves a stream source, transcodes to 720p H.264 + Opus, and broadcasts to Discord via WebRTC with DAVE encryption.

---

## Command Decision Tree

Use this to select the correct command for a given task:

```
What do you want to stream?
│
├─ A direct video URL (.mp4, .mkv, .m3u8)?
│  └─ Use: play-url
│
├─ A movie or TV series by name?
│  └─ Use: play-search
│     Requires: STREMIO_ADDON_URL env var (Torrentio + Real-Debrid)
│     Note: For series, you MUST provide --type series --season N --episode N
│
├─ A YouTube video by search query?
│  └─ Use: play-youtube
│     Requires: yt-dlp installed (included in Docker image)
│
└─ A live sports event (NBA, NFL, NHL, MLB, soccer, etc.)?
   └─ Use: play-live
      Searches sportsurge.ws for matching events by keyword
      No API key or external service required
```

---

## Commands

### `play-url` — Stream a direct video URL

Streams any HTTP(S) video URL to Discord. Use this when you already have a direct link to a video file or HLS playlist.

```bash
discord-stream play-url \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --url <VIDEO_URL>
```

| Flag | Required | Description |
|------|----------|-------------|
| `--guild-id <id>` | Yes | Discord server (guild) snowflake ID |
| `--channel-id <id>` | Yes | Voice channel snowflake ID |
| `--url <url>` | Yes | Direct video URL (mp4, mkv, m3u8, or any ffmpeg-compatible URL) |
| `--json` | No | Emit structured JSON logs instead of human-readable output |

**Supported formats:** Anything FFmpeg can read — MP4, MKV, WebM, HLS (.m3u8), DASH, RTMP, and more.

---

### `play-search` — Search and stream movies/TV via Stremio

Searches Cinemeta for a title, resolves a torrent stream through Torrentio with Real-Debrid, and streams the resulting direct download link.

```bash
discord-stream play-search \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --query "The Dark Knight"
```

For a TV series episode:

```bash
discord-stream play-search \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --query "Breaking Bad" \
  --type series \
  --season 1 \
  --episode 1
```

| Flag | Required | Description |
|------|----------|-------------|
| `--guild-id <id>` | Yes | Discord server (guild) snowflake ID |
| `--channel-id <id>` | Yes | Voice channel snowflake ID |
| `--query <query>` | Yes | Movie or TV show name |
| `--type <type>` | No | `movie` or `series` (auto-detected if omitted) |
| `--season <n>` | For series | Season number (integer) |
| `--episode <n>` | For series | Episode number (integer) |
| `--json` | No | Emit structured JSON logs |

**Prerequisites:**
- `STREMIO_ADDON_URL` environment variable must be set to a Torrentio addon manifest URL with Real-Debrid credentials.
- Get yours at: https://torrentio.strem.fun/ — configure Real-Debrid, then copy the manifest URL.
- Example: `https://torrentio.strem.fun/realdebrid=APIKEY/manifest.json`

**How resolution works:**
1. Searches Cinemeta (Stremio's metadata service) for the query
2. Takes the first match and queries Torrentio for available torrent streams
3. Selects the highest-quality stream and resolves it through Real-Debrid to a direct HTTPS download link
4. Passes the direct link into the streaming pipeline

---

### `play-youtube` — Search and stream YouTube

Searches YouTube using yt-dlp, extracts the direct stream URL, and streams it.

```bash
discord-stream play-youtube \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --query "lofi hip hop"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--guild-id <id>` | Yes | Discord server (guild) snowflake ID |
| `--channel-id <id>` | Yes | Voice channel snowflake ID |
| `--query <query>` | Yes | YouTube search query (takes the first result) |
| `--json` | No | Emit structured JSON logs |

**Prerequisites:**
- `yt-dlp` must be installed and accessible on `$PATH` (or set `YTDLP_PATH`).
- Included in the Docker image.

**How resolution works:**
1. Runs `yt-dlp --dump-json --no-playlist -f "bv*[height<=1080]+ba/b" "ytsearch1:<query>"`
2. Prefers separate video (up to 1080p) + audio HTTPS streams to avoid HLS manifests that require cookies
3. Falls back to a single combined stream if split formats are unavailable
4. When split streams are used, FFmpeg merges them with dual `-i` inputs

---

### `play-live` — Stream live sports events

Finds a live sports event by keyword and streams it from sportsurge.ws. No API key or external account is required.

```bash
discord-stream play-live \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --query "nba knicks"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--guild-id <id>` | Yes | Discord server (guild) snowflake ID |
| `--channel-id <id>` | Yes | Voice channel snowflake ID |
| `--query <query>` | Yes | Event search keywords (team names, league, etc.) |
| `--json` | No | Emit structured JSON logs |

**Query examples:**
- `"nba knicks"` — finds the current Knicks game
- `"nhl maple leafs"` — finds the current Maple Leafs game
- `"chiefs 49ers"` — finds an NFL game with both teams
- `"dominican republic usa"` — finds a World Baseball Classic game
- `"premier league arsenal"` — finds an Arsenal soccer match

**How resolution works:**
1. Fetches the sportsurge.ws homepage and parses all live event links
2. Fuzzy-matches the query against event titles and sport categories using word-overlap scoring
3. Fetches the matched event page and extracts the stream embed ID
4. Fetches the embed page and base64-decodes the HLS playlist URL from the Clappr player config
5. Returns the HLS URL with required HTTP headers (Referer/Origin) for the CDN

**Matching algorithm:** Tokenizes both the query and each event title, then scores by counting exact token matches (2 points) and substring matches (1 point). The highest-scoring event wins. Both team names and sport/league names are matchable.

---

## Environment Variables

| Variable | Required | Default | Used By | Description |
|----------|----------|---------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | All | Discord **user** token (not a bot token) |
| `LOG_LEVEL` | No | `info` | All | `debug`, `info`, `warn`, or `error` |
| `FFMPEG_PATH` | No | `ffmpeg` | All | Path to ffmpeg binary |
| `FFPROBE_PATH` | No | `ffprobe` | All | Path to ffprobe binary |
| `YTDLP_PATH` | No | `yt-dlp` | play-youtube | Path to yt-dlp binary |
| `STREMIO_ADDON_URL` | For play-search | — | play-search | Torrentio manifest URL with Real-Debrid credentials |

Create a `.env` file from the example:

```bash
cp .env.example .env
# Edit .env and fill in DISCORD_TOKEN (and STREMIO_ADDON_URL if using play-search)
```

---

## Installation

### Docker (recommended — fully portable)

```bash
# Build the image
docker build -t discord-stream .

# Stream a direct URL
docker run --rm --env-file .env \
  discord-stream play-url \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --url "https://example.com/video.mp4"

# Stream a movie
docker run --rm --env-file .env \
  discord-stream play-search \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --query "Interstellar"

# Stream YouTube
docker run --rm --env-file .env \
  discord-stream play-youtube \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --query "lofi hip hop radio"

# Stream a live sports event
docker run --rm --env-file .env \
  discord-stream play-live \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --query "nba lakers"
```

### Docker Compose

```bash
# Edit docker-compose.yml to set the command you want, then:
docker compose up --build
```

### Local (macOS / Linux)

**System requirements:**
- Node.js 22 or 23 (not 24)
- FFmpeg with libx264 and libopus
- yt-dlp (for play-youtube only)

```bash
# macOS (Homebrew)
brew install node@22 ffmpeg yt-dlp

# Ubuntu / Debian
sudo apt install ffmpeg
pip install yt-dlp
# Install Node 22 via nvm, fnm, or nodesource

# Install project dependencies
npm ci

# Build
npm run build

# Run
node dist/src/index.js play-url \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --url "https://example.com/video.mp4"
```

For development (no build step needed):

```bash
npx tsx src/index.ts play-live \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --query "nba knicks"
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         CLI Layer                            │
│  play-url  │  play-search  │  play-youtube  │  play-live     │
└─────┬──────┴───────┬───────┴───────┬────────┴───────┬────────┘
      │              │               │                │
      │      ┌───────▼──────┐  ┌─────▼──────┐  ┌─────▼──────┐
      │      │ StremioResolver │ │YouTubeResolver│ │LiveResolver │
      │      │ Cinemeta search │ │yt-dlp search  │ │sportsurge.ws│
      │      │ Torrentio + RD  │ │split streams  │ │HTML scraping│
      │      └───────┬──────┘  └─────┬──────┘  └─────┬──────┘
      │              │               │                │
      └──────────────┴───────────────┴────────────────┘
                              │
                     Direct video URL
                              │
                    ┌─────────▼─────────┐
                    │   ffprobe (Probe)  │
                    │   Analyze source   │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  TranscodePlan     │
                    │  720p 30fps cap    │
                    │  H.264 + Opus      │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  FFmpeg Pipeline   │
                    │  NUT mux → pipe    │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  NUT Demuxer       │
                    │  node-av parsing   │
                    │  H.264 + Opus pkts │
                    └─────────┬─────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
     ┌─────────▼─────────┐       ┌───────────▼───────────┐
     │   VideoStream      │       │    AudioStream        │
     │   H.264 → RTP      │       │    Opus → RTP         │
     └─────────┬─────────┘       └───────────┬───────────┘
               │                             │
               └──────────────┬──────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  DAVE Encryption   │
                    │  libdave.wasm      │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  WebRTC / Discord  │
                    │  Go Live stream    │
                    └───────────────────┘
```

**Transcode strategy:** All video is re-encoded to H.264 at 720p 30fps (fast preset, zerolatency tune) with a 2500 kbps target bitrate. Audio is transcoded to Opus at 128 kbps stereo 48 kHz. If the source has an English subtitle track (SRT/ASS/WebVTT), it is burned into the video.

---

## Project Structure

```
src/
├── index.ts                 # CLI entry point (commander)
├── config/                  # Environment variable loading + validation
├── discord/
│   ├── dave/                # DAVE encryption (libdave.wasm)
│   ├── gateway/             # Discord gateway WebSocket
│   ├── voice/               # Voice channel connection
│   └── streamer/            # Go Live stream orchestration
├── media/
│   ├── Probe.ts             # ffprobe wrapper
│   ├── TranscodePlan.ts     # Decides transcode parameters
│   ├── FFmpegPipeline.ts    # Spawns ffmpeg, outputs NUT to pipe
│   ├── Demuxer.ts           # Parses NUT stream into H.264/Opus packets
│   ├── VideoStream.ts       # H.264 RTP packetizer
│   ├── AudioStream.ts       # Opus RTP packetizer
│   └── MediaService.ts      # Effect service combining the above
├── transport/               # WebRTC connection + SDP
├── stremio/                 # Cinemeta search + Torrentio RD resolution
├── youtube/                 # yt-dlp wrapper
├── live/                    # sportsurge.ws scraper
├── errors/                  # Tagged error types + exit codes
└── utils/                   # Structured JSON logger

vendor/
└── libdave/                 # Vendored DAVE WASM module
    ├── libdave.wasm
    ├── libdave.js
    └── libdave.d.ts

tests/                       # Vitest unit tests
```

---

## How to Get a Discord User Token

This tool requires a Discord **user token** (not a bot token). The token authenticates as your Discord account to join voice channels and create Go Live streams — capabilities that bot tokens do not have.

**To find your token:**
1. Open Discord in a web browser
2. Open Developer Tools (F12)
3. Go to the Network tab
4. Look for any request to `discord.com/api` and find the `Authorization` header
5. That header value is your user token

**Security warning:** Your user token grants full access to your Discord account. Never share it publicly or commit it to version control. Use `.env` files or Docker secrets.

---

## Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Type-check without emitting
npm run typecheck
```

---

## Troubleshooting

**FFmpeg hangs on HLS streams:** The `-reconnect` flags interfere with FFmpeg's HLS demuxer. This is handled automatically — reconnect flags are skipped for HLS/playlist URLs.

**ffprobe returns 403 Forbidden:** Some CDNs require HTTP headers (Referer, Origin). The `play-live` command passes these automatically. For `play-url`, ensure your URL doesn't require special headers.

**yt-dlp not found:** Install it (`pip install yt-dlp`) or set the `YTDLP_PATH` environment variable. The Docker image includes it.

**Voice join timeout:** Verify that `--guild-id` and `--channel-id` are correct snowflake IDs and that the Discord account (identified by `DISCORD_TOKEN`) has permission to join the voice channel.

**"No results found":** For `play-search`, check that `STREMIO_ADDON_URL` is set and valid. For `play-live`, the query must match a currently-live event on sportsurge.ws — there are no results when no games are on.
