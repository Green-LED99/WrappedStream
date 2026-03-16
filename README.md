<p align="center">
  <h1 align="center">WrappedStream</h1>
  <p align="center">
    Stream video and audio to Discord voice channels via Go Live — with DAVE encryption, WebRTC, and hardware-accelerated transcoding.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22%20%3C24-brightgreen" alt="Node.js">
  <img src="https://img.shields.io/badge/typescript-5.8-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-private-lightgrey" alt="License">
</p>

---

A CLI tool designed to be invoked programmatically by an agent or script. It resolves a stream source, transcodes to H.264 + Opus, and broadcasts to Discord via WebRTC with full [DAVE](https://daveprotocol.com/) (Discord Audio Video Encryption) support.

## Command Decision Tree

```
What do you want to stream?
│
├─ A direct video URL (.mp4, .mkv, .m3u8)?
│  └─ Use: play-url
│
├─ A movie or TV series by name?
│  └─ Use: play-search
│     Requires: STREMIO_ADDON_URL (Torrentio + Real-Debrid)
│     Note: For series, you MUST provide --type series --season N --episode N
│
├─ A YouTube video by search query?
│  └─ Use: play-youtube
│     Requires: yt-dlp installed (included in Docker image)
│
└─ A live sports event (NBA, NFL, NHL, MLB, soccer, etc.)?
   └─ Use: play-live
      Searches sportsurge.ws for matching events by keyword
```

---

## Commands

### `play-url` — Stream a direct video URL

Streams any HTTP(S) video URL to Discord. Use when you already have a direct link to a video file or HLS playlist.

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
| `--url <url>` | Yes | Direct video URL (mp4, mkv, m3u8, or any FFmpeg-compatible URL) |

**Supported formats:** Anything FFmpeg can read — MP4, MKV, WebM, HLS (.m3u8), DASH, RTMP, and more.

---

### `play-search` — Search and stream movies/TV via Stremio

Searches Cinemeta for a title, resolves a torrent stream through Torrentio with Real-Debrid, and streams the resulting direct download link.

```bash
# Movie
discord-stream play-search \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --query "The Dark Knight"

# TV series episode
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
| `--season <n>` | For series | Season number |
| `--episode <n>` | For series | Episode number |

**Prerequisites:**
- `STREMIO_ADDON_URL` must be set to a Torrentio addon manifest URL with Real-Debrid credentials.
- Get yours at: https://torrentio.strem.fun/ — configure Real-Debrid, then copy the manifest URL.

**How resolution works:**
1. Searches Cinemeta (Stremio's metadata service) for the query
2. Takes the first match and queries Torrentio for available torrent streams
3. Selects the highest-quality stream and resolves it through Real-Debrid to a direct HTTPS link
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

**Prerequisites:**
- `yt-dlp` must be installed and on `$PATH` (or set `YTDLP_PATH`). Included in the Docker image.

**How resolution works:**
1. Runs `yt-dlp` with `ytsearch1:<query>` to find the top result
2. Prefers separate video (up to 1080p) + audio HTTPS streams to avoid HLS manifests requiring cookies
3. Falls back to a single combined stream if split formats are unavailable
4. When split streams are used, FFmpeg merges them with dual `-i` inputs

---

### `play-live` — Stream live sports events

Finds a live sports event by keyword and streams it from sportsurge.ws. No API key or external account required.

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

**Query examples:**
- `"nba knicks"` — current Knicks game
- `"nhl maple leafs"` — current Maple Leafs game
- `"chiefs 49ers"` — NFL game with both teams
- `"premier league arsenal"` — Arsenal soccer match

**Matching algorithm:** Tokenizes query and event titles, scores by exact token matches (2 pts) and substring matches (1 pt). The highest-scoring event wins. Both team names and sport/league names are matchable.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | **Yes** | — | Discord **user** token (not a bot token) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `FFMPEG_PATH` | No | `ffmpeg` | Path to FFmpeg binary |
| `FFPROBE_PATH` | No | `ffprobe` | Path to ffprobe binary |
| `YTDLP_PATH` | No | `yt-dlp` | Path to yt-dlp binary |
| `STREMIO_ADDON_URL` | For `play-search` | — | Torrentio manifest URL with Real-Debrid credentials |
| `VIDEO_ENCODER` | No | `auto` | Video encoder: `auto`, `h264_nvmpi`, `h264_v4l2m2m`, or `libx264` |
| `LANGUAGE` | No | `eng` | Preferred language for audio and subtitle selection (ISO 639-2/1 code) |
| `SUBTITLE_BURN_IN` | No | `auto` | Subtitle burn-in: `auto` (burn matching-language subs if found) or `never` |
| `PERFORMANCE_PROFILE` | No | `default` | `default` (720p/30fps) or `low-power` (720p/24fps, lower bitrate) |

```bash
cp .env.example .env
# Edit .env and fill in DISCORD_TOKEN (and STREMIO_ADDON_URL if using play-search)
```

---

## Installation

### Docker (recommended)

```bash
docker build -t discord-stream .

docker run --rm --env-file .env \
  discord-stream play-url \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --url "https://example.com/video.mp4"
```

### Docker Compose

```bash
# Edit docker-compose.yml to set your command, then:
docker compose up --build
```

### Local (macOS / Linux)

**System requirements:**
- Node.js 22 or 23 (not 24)
- FFmpeg with libx264 and libopus
- yt-dlp (for `play-youtube` only)

```bash
# macOS (Homebrew)
brew install node@22 ffmpeg yt-dlp

# Ubuntu / Debian
sudo apt install ffmpeg
pip install yt-dlp
# Install Node 22 via nvm, fnm, or nodesource

# Install dependencies and build
npm ci && npm run build

# Run
node dist/src/index.js play-url \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --url "https://example.com/video.mp4"
```

**Development** (no build step):

```bash
npx tsx src/index.ts play-url \
  --guild-id 123456789 \
  --channel-id 987654321 \
  --url "https://example.com/video.mp4"
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
      │      │StremioResolver│  │YouTubeResolver│ │LiveResolver │
      │      │Cinemeta search│  │yt-dlp search  │ │sportsurge.ws│
      │      │Torrentio + RD │  │split streams  │ │HTML scraping│
      │      └───────┬──────┘  └─────┬──────┘  └─────┬──────┘
      │              │               │                │
      └──────────────┴───────────────┴────────────────┘
                              │
                     Direct video URL(s)
                              │
                    ┌─────────▼─────────┐
                    │   ffprobe (Probe)  │
                    │   Analyze source   │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Encoder Detect   │
                    │  HW/SW auto-select │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  TranscodePlan     │
                    │  Profile-aware     │
                    │  copy-or-transcode │
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
     │   PTS sync          │       │    PTS sync           │
     └─────────┬─────────┘       └───────────┬───────────┘
               │                             │
               └──────────────┬──────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  DAVE Encryption   │
                    │  libdave.wasm      │
                    │  MLS key ratchet   │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  WebRTC Transport  │
                    │  Discord Go Live   │
                    └───────────────────┘
```

### Transcode Strategy

The pipeline inspects each source and builds a per-stream plan:

| | Default profile | Low-power profile |
|---|---|---|
| **Resolution cap** | 720p | 720p |
| **Frame rate cap** | 30 fps | 24 fps |
| **Video bitrate** | 2500 kbps target / 4500 kbps max | 1800 kbps target / 3500 kbps max |
| **Audio** | Opus 128 kbps stereo 48 kHz | Opus 128 kbps stereo 48 kHz |
| **x264 preset** | `fast` | `superfast` |

**Video copy mode:** If the source is already H.264 at or below the target resolution and frame rate, and no subtitle burn-in is needed, the video stream is copied without re-encoding.

**Audio copy mode:** If the source audio is already Opus at 48 kHz with 1–2 channels, it is copied directly.

**Encoder selection** (`VIDEO_ENCODER`):
- `auto` (default) — probes FFmpeg for hardware encoders in order: `h264_nvmpi` (Jetson), `h264_v4l2m2m` (Raspberry Pi), then falls back to `libx264`
- Explicit values skip auto-detection and use the specified encoder directly
- The `zerolatency` tune is applied only when using `libx264`

**Language selection** (`LANGUAGE`):
- Controls which audio track and subtitle track are selected from the source
- Accepts ISO 639-2/B three-letter codes (`eng`, `fre`, `jpn`, `spa`) or ISO 639-1 two-letter codes (`en`, `fr`, `ja`, `es`)
- When multiple audio tracks exist, the one matching the language is selected; falls back to the first audio track if no match
- Default: `eng`

**Subtitle burn-in** (`SUBTITLE_BURN_IN`):
- `auto` (default) — if a text subtitle track (SRT/ASS/WebVTT) matching `LANGUAGE` is detected, it is burned into the video via the FFmpeg `subtitles` filter
- `never` — subtitles are never burned in, even if present

---

## Project Structure

```
src/
├── index.ts                 # CLI entry point (commander)
├── config/                  # Environment variable loading + validation (Effect Schema)
├── discord/
│   ├── dave/                # DAVE encryption (libdave.wasm, MLS sessions)
│   ├── gateway/             # Discord Gateway v9 WebSocket (identify, resume, heartbeat)
│   ├── voice/               # Voice Gateway v9 (WebRTC select protocol, DAVE handshake)
│   └── streamer/            # Go Live orchestration (voice + stream join coordinators)
├── media/
│   ├── Probe.ts             # ffprobe wrapper + subtitle detection
│   ├── EncoderDetect.ts     # Hardware encoder auto-detection
│   ├── TranscodePlan.ts     # Profile-aware transcode/copy decision engine
│   ├── FFmpegPipeline.ts    # Spawns FFmpeg, outputs NUT container to pipe
│   ├── Demuxer.ts           # NUT demuxer with h264_mp4toannexb bitstream filter
│   ├── BaseMediaStream.ts   # Writable stream base with PTS timing and A/V sync
│   ├── VideoStream.ts       # H.264 RTP packetizer (extends BaseMediaStream)
│   ├── AudioStream.ts       # Opus RTP packetizer (extends BaseMediaStream)
│   └── MediaService.ts      # Effect service combining the above
├── transport/               # WebRTC peer connection, SDP negotiation, RTP transport
├── stremio/                 # Cinemeta search + Torrentio Real-Debrid resolution
├── youtube/                 # yt-dlp wrapper (split video+audio stream support)
├── live/                    # sportsurge.ws scraper + fuzzy event matching
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
2. Open Developer Tools (`F12`)
3. Go to the **Network** tab
4. Look for any request to `discord.com/api` and find the `Authorization` header
5. That header value is your user token

> **Security warning:** Your user token grants full access to your Discord account. Never share it publicly or commit it to version control. Use `.env` files or Docker secrets.

---

## Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run typecheck     # Type-check without emitting
npm run lint          # Lint with Biome
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **FFmpeg hangs on HLS streams** | Reconnect flags interfere with the HLS demuxer. This is handled automatically — reconnect flags are skipped for `.m3u8` / playlist URLs. |
| **ffprobe returns 403 Forbidden** | Some CDNs require HTTP headers (Referer, Origin). `play-live` passes these automatically. For `play-url`, ensure your URL doesn't need special headers. |
| **yt-dlp not found** | Install it (`pip install yt-dlp`) or set `YTDLP_PATH`. The Docker image includes it. |
| **Voice join timeout** | Verify `--guild-id` and `--channel-id` are correct snowflake IDs and that the account has permission to join the voice channel. |
| **"No results found"** | For `play-search`, check that `STREMIO_ADDON_URL` is set and valid. For `play-live`, the query must match a currently-live event — no results when no games are on. |
| **Hardware encoder not detected** | Set `VIDEO_ENCODER=libx264` to force software encoding, or verify your FFmpeg build includes the hardware encoder (`ffmpeg -encoders \| grep h264`). |
