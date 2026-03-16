# WrappedStream

Stream video and audio to a Discord voice channel via Go Live. Supports direct URLs, movie/TV search (Stremio + Real-Debrid), YouTube, and live sports.

This is a CLI tool designed to be invoked programmatically by an agent or script. It takes a command, resolves a stream source, encodes (or copies) to H.264 + Opus, and broadcasts to Discord via WebRTC with DAVE end-to-end encryption.

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
node dist/src/index.js play-url \
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
node dist/src/index.js play-search \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --query "The Dark Knight"
```

For a TV series episode:

```bash
node dist/src/index.js play-search \
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
node dist/src/index.js play-youtube \
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
node dist/src/index.js play-live \
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
| `VIDEO_ENCODER` | No | `auto` | All | Video encoder: `auto`, `h264_nvmpi`, `h264_v4l2m2m`, or `libx264` (see [Performance Tuning](#performance-tuning)) |
| `SUBTITLE_BURN_IN` | No | `auto` | All | `auto` (burn English subs if found) or `never` (skip subtitle rendering) |
| `PERFORMANCE_PROFILE` | No | `default` | All | `default` or `low-power` (see [Performance Tuning](#performance-tuning)) |

Create a `.env` file from the example:

```bash
cp .env.example .env
# Edit .env and fill in DISCORD_TOKEN (and STREMIO_ADDON_URL if using play-search)
```

---

## Performance Tuning

The transcode pipeline is configurable for low-power devices like Jetson Nano, Raspberry Pi, or any ARM SBC.

### Video Encoder Selection (`VIDEO_ENCODER`)

At startup, the tool probes `ffmpeg -encoders` to discover available H.264 encoders. The `auto` setting picks the best available in this order:

| Priority | Encoder | Description | CPU Impact |
|----------|---------|-------------|------------|
| 1 | `h264_nvmpi` | NVIDIA Jetson hardware encoder (requires [jetson-ffmpeg](https://github.com/jocover/jetson-ffmpeg)) | Near zero |
| 2 | `h264_v4l2m2m` | V4L2 Memory-to-Memory hardware encoder (generic Linux HW) | Near zero |
| 3 | `libx264` | Software encoder (always available) | High |

To force a specific encoder: `VIDEO_ENCODER=h264_nvmpi`. If the requested encoder is not found in FFmpeg, the tool exits with an error rather than silently falling back.

**Jetson Nano setup:** You need an FFmpeg build that includes `h264_nvmpi`. The standard Debian/Ubuntu `ffmpeg` package does **not** include it. Install [jetson-ffmpeg](https://github.com/jocover/jetson-ffmpeg), then set `FFMPEG_PATH` to point to the patched binary.

### Video Copy Mode

When the source video is already H.264 at or below the target resolution and frame rate, FFmpeg passes through the original encoded frames without re-encoding (`-c:v copy`). This uses zero CPU for the video track. Copy mode is selected automatically — no configuration needed.

Copy mode is **not** used when:
- The source codec is not H.264 (e.g., VP9, HEVC, AV1)
- The source resolution exceeds 720p
- The source frame rate exceeds the target (30fps default, 24fps in low-power)
- Subtitle burn-in is active (rendering text onto frames requires decoding)

To maximize copy-mode eligibility, set `SUBTITLE_BURN_IN=never` to prevent subtitle rendering from forcing a transcode.

### Performance Profiles (`PERFORMANCE_PROFILE`)

| Profile | Target FPS | Video Bitrate | Max Bitrate | libx264 Preset | Use Case |
|---------|-----------|---------------|-------------|----------------|----------|
| `default` | 30 | 2500 kbps | 4500 kbps | `fast` | Desktop / server with spare CPU |
| `low-power` | 24 | 1800 kbps | 3500 kbps | `superfast` | Jetson Nano, Raspberry Pi, ARM SBCs |

The `low-power` profile reduces CPU usage by roughly 3-4x when software encoding (libx264) is used: `superfast` is 2-3x faster than `fast`, and 24fps produces 20% fewer frames than 30fps.

**Note:** The profile only affects software encoding. Hardware encoders handle any supported resolution/fps with near-zero CPU regardless of profile.

### Recommended Settings by Device

**Jetson Nano (4GB):**
```bash
VIDEO_ENCODER=auto              # auto-detects h264_nvmpi if jetson-ffmpeg is installed
PERFORMANCE_PROFILE=low-power   # fallback to superfast/24fps if HW encoder unavailable
SUBTITLE_BURN_IN=never          # avoid forced transcode from subtitle rendering
```

**Raspberry Pi 4/5:**
```bash
VIDEO_ENCODER=auto              # auto-detects h264_v4l2m2m
PERFORMANCE_PROFILE=low-power
SUBTITLE_BURN_IN=never
```

**Desktop / Cloud server:**
```bash
# Defaults are fine — no env vars needed
# VIDEO_ENCODER=auto (uses libx264)
# PERFORMANCE_PROFILE=default (30fps, 2500kbps, fast preset)
# SUBTITLE_BURN_IN=auto (burns English subs if present)
```

### Pipeline Stats

Set `LOG_LEVEL=debug` to see per-stream diagnostics emitted every ~10 seconds:

```json
{
  "framesProcessed": 300,
  "lateFrames": 2,
  "maxLatenessMs": 45.3,
  "maxSendMs": 12.1
}
```

- `lateFrames` — frames delivered behind schedule (pacing engine couldn't keep up). Sustained late frames indicate CPU saturation.
- `maxLatenessMs` — worst-case frame delay in ms. Values >100ms cause visible stuttering.
- `maxSendMs` — longest time spent in a single `sendFrame` call. High values indicate WebRTC/network backpressure.

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

**Note:** The default Docker image uses Debian Bookworm's FFmpeg, which only includes `libx264` (software encoding). For Jetson Nano hardware encoding, you need a custom image with [jetson-ffmpeg](https://github.com/jocover/jetson-ffmpeg) installed and `FFMPEG_PATH` pointing to the patched binary.

### Docker Compose

```bash
# Edit docker-compose.yml to set the command you want, then:
docker compose up --build
```

### Local (macOS / Linux)

**System requirements:**
- Node.js 22 or 23 (not 24 — native addon compatibility)
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
                    │  Encoder Detection │
                    │  nvmpi > v4l2 > sw │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  TranscodePlan     │
                    │  copy or transcode │
                    │  720p cap, H.264   │
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
     │   PTS pacing       │       │    PTS pacing         │
     │   Pipeline stats   │       │    A/V sync ref       │
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
                    │  WebRTC / Discord  │
                    │  Go Live stream    │
                    └───────────────────┘
```

### Transcode Strategy

The pipeline has three modes for video, selected automatically:

1. **Copy** (`-c:v copy`): Source is H.264 at ≤720p and ≤target FPS with no subtitle burn-in needed. Zero CPU cost — original encoded frames pass through untouched.
2. **Hardware transcode**: Source needs re-encoding and a hardware encoder is available (`h264_nvmpi` or `h264_v4l2m2m`). Near-zero CPU cost.
3. **Software transcode**: Falls back to `libx264`. Preset and bitrate depend on the performance profile (`fast`/2500kbps or `superfast`/1800kbps).

Audio uses the same logic: Opus at 48kHz stereo is copied; everything else is transcoded to Opus 128kbps stereo 48kHz.

If the source has an English text subtitle track (SRT/ASS/WebVTT) and `SUBTITLE_BURN_IN` is not `never`, subtitles are rendered into the video via FFmpeg's `subtitles` filter. This forces video transcode even if the source would otherwise qualify for copy mode.

### DAVE End-to-End Encryption

All frames are encrypted using Discord's DAVE protocol (Discord Audio/Video Encryption) before transmission. DAVE uses MLS (Messaging Layer Security) for key management and a per-frame encrypt operation via `libdave.wasm`.

Key points for the encryption flow:
- The `DaveMediaEncryptor` encrypts individual H.264 NAL units (video) and Opus frames (audio) after demuxing but before RTP packetization.
- Encryption operates on raw codec frames, not on the container or transport layer. This means **copy mode is fully compatible with DAVE** — the demuxer produces the same Annex-B H.264 frames whether they were transcoded or copied.
- During the MLS handshake (before key ratchets are established), frames pass through unencrypted. Once the handshake completes, all subsequent frames are encrypted.
- The `DaveSessionManager` handles MLS protocol transitions, epoch management, and user roster changes (joins/leaves) automatically via voice gateway opcodes.

### Demuxer and Bitstream Filters

FFmpeg outputs a NUT container to stdout. The `node-av` library demuxes it into separate video and audio packet streams. Three bitstream filters are applied to H.264 video:

1. `h264_mp4toannexb` — converts MP4-style NAL units to Annex-B start codes (required by the H264RtpPacketizer)
2. `h264_metadata` — removes Access Unit Delimiter (AUD) NAL units (not needed for RTP)
3. `dump_extra` — ensures SPS/PPS parameter sets precede each keyframe (required for mid-stream joins)

These filters run identically on both transcoded and copied video. The demuxer also parses Opus packet headers to extract frame duration for accurate A/V synchronization.

### Pacing and Synchronization

`BaseMediaStream` is a Node.js `Writable` that rate-controls frame delivery to match real-time playback:

- PTS (Presentation Timestamp) from each packet is converted to milliseconds and used to calculate the target wall-clock time for delivery.
- The pacing engine sleeps between frames: `sleep = max(0, targetElapsed - actualElapsed)`.
- Audio is the sync reference. If video runs ahead of audio by more than 20ms, video sleeps for one frame duration to let audio catch up.
- Pipeline stats (late frames, max lateness, max send duration) are tracked and emitted every 300 frames for diagnostics.

---

## Project Structure

```
src/
├── index.ts                 # CLI entry point (commander)
├── config/                  # Environment variable loading + validation
├── discord/
│   ├── dave/                # DAVE encryption (libdave.wasm, MLS session)
│   ├── gateway/             # Discord gateway WebSocket
│   ├── voice/               # Voice channel connection + signaling
│   └── streamer/            # Go Live stream orchestration
├── media/
│   ├── Probe.ts             # ffprobe wrapper (codec, resolution, subtitle detection)
│   ├── EncoderDetect.ts     # Probes ffmpeg for available H.264 encoders
│   ├── TranscodePlan.ts     # Decides copy vs transcode, encoder, profile params
│   ├── FFmpegPipeline.ts    # Builds ffmpeg args, spawns process, NUT output to pipe
│   ├── Demuxer.ts           # Parses NUT stream into H.264/Opus packets (node-av)
│   ├── BaseMediaStream.ts   # PTS pacing engine with pipeline stats
│   ├── VideoStream.ts       # Sends H.264 frames to WebRtcConnection
│   ├── AudioStream.ts       # Sends Opus frames to WebRtcConnection
│   └── MediaService.ts      # Effect service combining the above
├── transport/
│   ├── WebRtcConnection.ts  # PeerConnection, RTP packetizers, DAVE encrypt + send
│   ├── codec.ts             # RTP payload type constants
│   └── sdp.ts               # SDP answer builder
├── stremio/                 # Cinemeta search + Torrentio RD resolution
├── youtube/                 # yt-dlp wrapper
├── live/                    # sportsurge.ws scraper
├── errors/                  # Tagged error types + exit codes
└── utils/                   # Structured JSON logger

vendor/
└── libdave/                 # Vendored DAVE WASM module (do NOT remove)
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

**Hardware encoder not detected:** Run `ffmpeg -encoders | grep h264` to verify your FFmpeg build includes the encoder you expect. On Jetson Nano, the standard apt `ffmpeg` does **not** include `h264_nvmpi` — you need [jetson-ffmpeg](https://github.com/jocover/jetson-ffmpeg). If using `VIDEO_ENCODER=auto`, check the startup logs for "Encoder detected" to see what was selected.

**High CPU / stuttering on ARM devices:** Set `PERFORMANCE_PROFILE=low-power` and `SUBTITLE_BURN_IN=never`. Check `LOG_LEVEL=debug` output for `lateFrames` — if this number climbs steadily, the encoder can't keep up. Consider installing a hardware encoder or reducing source complexity.

**Subtitle burn-in forcing transcode on copy-eligible source:** When an English subtitle track is detected and `SUBTITLE_BURN_IN=auto` (the default), subtitle rendering forces full video transcode even if the source would otherwise qualify for zero-CPU copy mode. Set `SUBTITLE_BURN_IN=never` to disable this.

**Node.js version compatibility:** Use Node.js 22 or 23. Node 24 is not supported due to native addon compatibility issues with `@lng2004/node-datachannel` and `node-av`.

**`vendor/libdave/` missing or corrupted:** The DAVE WASM module is vendored and must be present at `vendor/libdave/libdave.wasm` and `vendor/libdave/libdave.js`. If these files are missing, DAVE encryption will fail to initialize and the stream will not connect. Do not delete or modify the `vendor/` directory.
