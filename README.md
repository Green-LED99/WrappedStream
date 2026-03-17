<h1 align="center">WrappedStream</h1>

<p align="center">
  Stream video and audio to Discord voice channels via Go Live — with DAVE E2EE, WebRTC transport, and hardware-accelerated transcoding.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22%20%3C24-brightgreen" alt="Node.js">
  <img src="https://img.shields.io/badge/typescript-5.8-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/ffmpeg-5.x%E2%80%937.x-orange" alt="FFmpeg">
  <img src="https://img.shields.io/badge/tests-125%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/license-private-lightgrey" alt="License">
</p>

---

A CLI tool that resolves a stream source, transcodes to H.264 Constrained Baseline + Opus, and broadcasts to a Discord voice channel over WebRTC with full [DAVE](https://daveprotocol.com/) (Discord Audio Video End-to-End Encryption) support. Built with [Effect](https://effect.website/) for typed dependency injection, structured error handling, and composable service layers.

## Features

| Category | Details |
|----------|---------|
| **Go Live Streaming** | Join a voice channel and broadcast video as a screen share via Discord's Go Live protocol |
| **DAVE E2EE** | Full MLS 1.0 encryption via `libdave.wasm` with key ratchets, epoch transitions, and passthrough fallback |
| **Hardware Encoding** | Auto-detects `h264_nvmpi` (Jetson Nano) and `h264_v4l2m2m` (Raspberry Pi) with runtime probe verification |
| **Copy Mode** | Zero-CPU passthrough when source is H.264 Baseline/Main/High without B-frames, within target parameters |
| **Playback Controls** | Optional Discord slash commands: `/skip-forward`, `/skip-backward`, `/seek`, `/playtime`, `/next-episode` |
| **Series Auto-Play** | Automatically resolves and plays the next episode via Cinemeta metadata at season boundaries |
| **Multi-Source** | Direct URLs, YouTube search (yt-dlp), Stremio/Torrentio/Real-Debrid movies, and live sports |
| **ARM Optimized** | Three performance profiles, precision timing with hybrid spin-wait, and tuned buffer sizes for Cortex-A57 |
| **Audio/Video Sync** | Shared wall-clock reference with proportional drift correction (20ms tolerance) |
| **Process Safety** | Guaranteed FFmpeg cleanup via `finally` blocks, stream destruction to unblock demuxer, graceful SIGTERM→SIGKILL |

---

## Quick Start

```bash
# Install dependencies and build
npm ci && npm run build

# Create .env with your Discord user token
cp .env.example .env

# Stream a video
node dist/src/index.js play-url \
  --guild-id <GUILD_ID> \
  --channel-id <CHANNEL_ID> \
  --url "https://example.com/video.mp4"
```

---

## Commands

### `play-url` — Stream a direct video URL

```bash
discord-stream play-url \
  --guild-id <id> --channel-id <id> --url <url> \
  [--seek <seconds>] [--audio-stream <index>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--guild-id <id>` | Yes | Discord guild (server) snowflake ID |
| `--channel-id <id>` | Yes | Voice channel snowflake ID |
| `--url <url>` | Yes | Direct video URL (MP4, MKV, HLS, DASH, RTMP, or any FFmpeg-compatible source) |
| `--seek <seconds>` | No | Start playback at this position (uses FFmpeg fast keyframe seeking) |
| `--audio-stream <index>` | No | Select a specific audio stream by index (0-based, overrides language selection) |

### `play-url-with-commands` — Stream with Discord slash commands

Identical to `play-url` but also starts a Discord bot that registers guild-scoped slash commands for real-time playback control.

```bash
discord-stream play-url-with-commands \
  --guild-id <id> --channel-id <id> --url <url> \
  --bot-token <token> [--seek <seconds>] [--audio-stream <index>]
```

| Additional Flag | Required | Description |
|------|----------|-------------|
| `--bot-token <token>` | Yes | Discord **bot** token (separate from the user token in `.env`) |

**Available slash commands** (registered per-guild):

| Command | Description |
|---------|-------------|
| `/skip-forward <seconds>` | Skip forward by N seconds |
| `/skip-backward <seconds>` | Skip backward by N seconds |
| `/seek <time>` | Seek to a timestamp (`MM:SS` or `HH:MM:SS`) |
| `/playtime` | Display current position, duration, and progress |
| `/next-episode` | Skip to the next episode (series auto-play) |

The seek/skip mechanism is fully in-process: the `PlaybackStateManager` fires a restart event, the stream loop gracefully stops the current FFmpeg pipeline (`SIGTERM` with 2s `SIGKILL` fallback), and starts a new one at the target seek position — all within the same Discord voice connection.

### `play-search` — Stream movies/TV via Stremio

Searches Cinemeta for a title, resolves a torrent stream through Torrentio with Real-Debrid, and streams the resulting direct download link.

```bash
discord-stream play-search \
  --guild-id <id> --channel-id <id> \
  --query "The Dark Knight"

# TV series
discord-stream play-search \
  --guild-id <id> --channel-id <id> \
  --query "Breaking Bad" --type series --season 1 --episode 1
```

| Flag | Required | Description |
|------|----------|-------------|
| `--query <query>` | Yes | Movie or TV show name |
| `--type <type>` | No | `movie` or `series` (auto-detected if omitted) |
| `--season <n>` | For series | Season number |
| `--episode <n>` | For series | Episode number |
| `--no-auto-play` | No | Disable auto-play next episode (series only) |

**Auto-play next episode**: When streaming a TV series, the next episode is automatically resolved and played when the current one finishes. The tool queries Cinemeta for the full episode list, finds the next episode (S:E+1, or S+1:E1 at season boundaries), resolves it through Torrentio/Real-Debrid, and starts streaming. Disable with `--no-auto-play`.

Requires `STREMIO_ADDON_URL` — get yours at [torrentio.strem.fun](https://torrentio.strem.fun/).

### `play-youtube` — Stream from YouTube

```bash
discord-stream play-youtube \
  --guild-id <id> --channel-id <id> --query "lofi hip hop"
```

Uses `yt-dlp` under the hood. Prefers separate H.264 video + Opus audio HTTPS streams (avoids VP9/AV1 software decoding and AAC-to-Opus transcoding). Falls back to a combined stream if split formats are unavailable. FFmpeg merges split streams with dual `-i` inputs.

### `play-live` — Stream live sports

```bash
discord-stream play-live \
  --guild-id <id> --channel-id <id> --query "nba knicks"
```

Searches sportsurge.ws for matching events. Query examples: `"nhl maple leafs"`, `"chiefs 49ers"`, `"premier league arsenal"`.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | **Yes** | — | Discord **user** token (not a bot token) |
| `LOG_LEVEL` | No | `info` | `debug` / `info` / `warn` / `error` |
| `FFMPEG_PATH` | No | `ffmpeg` | Path to FFmpeg binary |
| `FFPROBE_PATH` | No | `ffprobe` | Path to ffprobe binary |
| `YTDLP_PATH` | No | `yt-dlp` | Path to yt-dlp binary |
| `STREMIO_ADDON_URL` | For `play-search` | — | Torrentio manifest URL with Real-Debrid credentials |
| `VIDEO_ENCODER` | No | `auto` | `auto` / `h264_nvmpi` / `h264_v4l2m2m` / `libx264` |
| `PERFORMANCE_PROFILE` | No | `default` | `default` / `low-power` / `ultra-low-power` |
| `LANGUAGE` | No | `eng` | ISO 639-2/B or 639-1 language code for audio/subtitle selection |
| `SUBTITLE_BURN_IN` | No | `auto` | `auto` (burn matching-language subs) or `never` |

---

## Performance Profiles

Three profiles control transcode parameters across the pipeline:

| Profile | Resolution | FPS | Video Bitrate | Max Bitrate | Audio | libx264 Preset |
|---------|-----------|-----|---------------|-------------|-------|----------------|
| `default` | 720p | 30 | 2500 kbps | 4500 kbps | 128 kbps Opus | `fast` |
| `low-power` | 720p | 24 | 1800 kbps | 2500 kbps | 96 kbps Opus | `ultrafast` |
| `ultra-low-power` | 480p | 20 | 1200 kbps | 1500 kbps | 64 kbps Opus | `ultrafast` |

The `low-power` profile is designed for Jetson Nano and Raspberry Pi. The `ultra-low-power` profile is for thermally throttled or multi-workload scenarios where maximum CPU conservation is critical.

### Encoder Selection

At startup, the tool probes `ffmpeg -encoders` and optionally test-encodes a single frame to verify hardware encoders work at runtime.

| Priority | Encoder | Platform | Notes |
|----------|---------|----------|-------|
| 1 | `h264_nvmpi` | NVIDIA Jetson | Requires [jetson-ffmpeg](https://github.com/jocover/jetson-ffmpeg). Near-zero CPU. |
| 2 | `libx264` | Universal | Always available. CPU-intensive but reliable. |
| 3 | `h264_v4l2m2m` | V4L2 Linux | Often listed by FFmpeg but fails at runtime — probed before use. |

### Copy Mode

When the source is already H.264 without B-frames, at or below target resolution and frame rate, and no subtitle burn-in is needed, the video stream is passed through without re-encoding (`-c:v copy`). Similarly, Opus audio at 48 kHz / 1-2 channels is copied directly.

The `has_b_frames` field from ffprobe is checked to safely allow copy mode for Main and High profile H.264 sources that don't actually use B-frames (common in YouTube and HLS CDN streams).

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                          CLI (commander)                        │
│  play-url  │  play-url-with-commands  │  play-search  │  ...   │
└──────┬─────┴──────────┬───────────────┴───────┬────────────────┘
       │                │                       │
       │       ┌────────▼────────┐     ┌────────▼────────┐
       │       │  CommandServer  │     │  Content         │
       │       │  Slash commands │     │  Resolvers       │
       │       │  PlaybackState  │     │  Stremio/YT/Live │
       │       └────────┬────────┘     └────────┬────────┘
       │                │                       │
       └────────────────┴───────────────────────┘
                        │
               Direct video URL(s)
                        │
              ┌─────────▼─────────┐
              │   ffprobe (Probe)  │  Analyze codec, resolution,
              │                    │  frame rate, B-frames, language
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │  Encoder Detect    │  Auto-detect HW encoders,
              │                    │  detect FFmpeg version
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │  TranscodePlan     │  Copy vs transcode decision
              │                    │  per performance profile
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │  FFmpeg Pipeline   │  H.264 + Opus → NUT mux → pipe:1
              │                    │  Fast seek, subtitle burn-in
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │  NUT Demuxer       │  node-av: 64KB buffer, H.264
              │                    │  bitstream filters (annexb,
              │                    │  metadata aud=remove, dump_extra)
              └─────────┬─────────┘
                        │
             ┌──────────┴──────────┐
             │                     │
   ┌─────────▼─────────┐ ┌────────▼─────────┐
   │  VideoStream       │ │  AudioStream      │
   │  PTS-synced pacing │ │  PTS-synced pacing│
   │  Shared ClockRef ◄─┼─► Shared ClockRef  │
   └─────────┬─────────┘ └────────┬──────────┘
             │                     │
             └──────────┬──────────┘
                        │
              ┌─────────▼─────────┐
              │  DAVE Encryption   │  MLS key ratchets,
              │  libdave.wasm      │  per-SSRC codec-aware
              │                    │  AES-128-GCM encryption
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │  WebRTC Transport  │  RTP: Opus PT=120, H264 PT=101
              │  node-datachannel  │  RTX PT=102, playout delay 0/0
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │  Discord Go Live   │  Voice Gateway v9 (opcodes 0-31),
              │  Streamer + Voice  │  Gateway v9 (opcodes 0-22),
              │  + Stream join     │  DTLS/SRTP, reconnect/resume
              └───────────────────┘
```

### Protocol Stack

| Layer | Implementation | Specification |
|-------|---------------|---------------|
| Gateway | WebSocket `wss://gateway/?v=9&encoding=json` | Opcodes 0-11 (standard), 18-22 (Go Live) |
| Voice Gateway | WebSocket `wss://server/?v=9` | Opcodes 0-16 (JSON), 21-24 (DAVE JSON), 25-30 (DAVE binary), 31 (MLS invalid) |
| Transport | WebRTC via `@lng2004/node-datachannel` | ICE/DTLS/SRTP (`UDP/TLS/RTP/SAVPF`), STUN via Google |
| Codec | H.264 Constrained Baseline Level 3.1 | `profile-level-id=42e01f`, `packetization-mode=1`, `level-asymmetry-allowed=1` |
| Audio | Opus 48kHz stereo, 20ms frames | `minptime=10;useinbandfec=1;usedtx=1` |
| RTP | PT 120 (Opus/48000), PT 101 (H264/90000), PT 102 (RTX) | Playout delay 0/0, RTCP-FB: ccm fir, nack, nack pli, goog-remb, transport-cc |
| Header Extensions | Audio: ssrc-audio-level (1), transport-wide-cc (3) | Video: abs-send-time (2), toffset (14), video-orientation (13), playout-delay (5) |
| Encryption | `libdave.wasm` (MLS 1.0) | P256_AES128GCM_SHA256_P256, per-sender key ratchets, epoch transitions |
| Media | FFmpeg → NUT pipe → `node-av` demux | H.264 Annex B (mp4toannexb + metadata aud=remove + dump_extra), Opus 48kHz/20ms |

---

## Project Structure

```
src/
├── index.ts                 # CLI entry point (commander)
├── config/                  # Environment config + Effect Schema validation
├── discord/
│   ├── CommandServer.ts     # Slash command bot (seek, skip, playtime, next-episode)
│   ├── PlaybackState.ts     # Session manager with restart emitter and series context
│   ├── dave/                # DAVE E2EE (libdave.wasm, MLS sessions, key ratchets)
│   ├── gateway/             # Discord Gateway v9 (identify, heartbeat, resume)
│   ├── voice/               # Voice Gateway v9 (WebRTC protocol, DAVE handshake)
│   └── streamer/            # Go Live orchestration (voice + stream join)
├── media/
│   ├── Probe.ts             # ffprobe wrapper + language-aware stream selection
│   ├── EncoderDetect.ts     # HW encoder auto-detection with runtime probe
│   ├── TranscodePlan.ts     # Profile-aware transcode/copy decision engine
│   ├── FFmpegPipeline.ts    # FFmpeg process with NUT output, fast seek, graceful stop
│   ├── Demuxer.ts           # NUT demuxer with H.264 bitstream filter chain
│   ├── BaseMediaStream.ts   # Writable stream with PTS timing and precision sleep
│   ├── VideoStream.ts       # H.264 frame sender (extends BaseMediaStream)
│   ├── AudioStream.ts       # Opus frame sender (extends BaseMediaStream)
│   └── MediaService.ts      # Effect service layer
├── transport/
│   ├── sdp.ts               # SDP builder (H.264 fmtp, RTP extensions, RTCP-FB)
│   ├── WebRtcConnection.ts  # RTP packetizer setup, playout delay, DAVE integration
│   └── codec.ts             # Payload type constants (Opus=120, H264=101, RTX=102)
├── stremio/                 # Cinemeta + Torrentio Real-Debrid resolution
├── youtube/                 # yt-dlp wrapper with H.264 + Opus format selection
├── live/                    # sportsurge.ws scraper + fuzzy event matching
├── errors/                  # Tagged error types (Effect Data.TaggedError)
└── utils/                   # Structured JSON logger

vendor/libdave/              # Vendored DAVE WASM module (do NOT remove)
tests/                       # Vitest unit tests
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
docker compose up --build
```

### Local

**System requirements:**
- Node.js 22 or 23
- FFmpeg with libx264 and libopus
- yt-dlp (for `play-youtube` only)

```bash
# macOS
brew install node@22 ffmpeg yt-dlp

# Ubuntu / Debian
sudo apt install ffmpeg
pip install yt-dlp

# Build and run
npm ci && npm run build
node dist/src/index.js play-url --guild-id <id> --channel-id <id> --url <url>
```

**Development** (no build step):

```bash
npx tsx src/index.ts play-url --guild-id <id> --channel-id <id> --url <url>
```

---

## How to Get a Discord User Token

This tool requires a Discord **user token** (not a bot token) to join voice channels and create Go Live streams.

1. Open Discord in a web browser
2. Open Developer Tools (`F12` or `Cmd+Opt+I`)
3. Go to the **Network** tab
4. Look for any request to `discord.com/api` and copy the `Authorization` header value

> **Warning:** Your user token grants full access to your Discord account. Never share it publicly or commit it to version control. Use `.env` files or Docker secrets.

---

## Pipeline Stats

Set `LOG_LEVEL=debug` to see per-stream diagnostics every ~300 frames:

```json
{
  "framesProcessed": 300,
  "lateFrames": 2,
  "maxLatenessMs": 45.3,
  "maxSendMs": 12.1
}
```

| Metric | Meaning | Action if high |
|--------|---------|----------------|
| `lateFrames` | Frames delivered behind schedule | CPU saturated — lower performance profile or use HW encoder |
| `maxLatenessMs` | Worst-case frame delay (ms) | Values >100ms cause visible stuttering |
| `maxSendMs` | Longest `sendFrame` call (ms) | High values indicate WebRTC/network backpressure |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| FFmpeg hangs on HLS streams | Reconnect flags are automatically skipped for `.m3u8` URLs — if still hanging, check FFmpeg version compatibility |
| `extension_picky` crash | Only applies to FFmpeg 7+. The tool detects FFmpeg version at startup and only uses this flag when safe. |
| ffprobe returns 403 | Some CDNs require HTTP headers. `play-live` passes these automatically. For `play-url`, ensure your URL is publicly accessible. |
| yt-dlp not found | Install via `pip install yt-dlp` or set `YTDLP_PATH`. Included in the Docker image. |
| Voice join timeout | Verify guild/channel IDs are correct and the account has voice channel permissions. |
| Hardware encoder not detected | Set `VIDEO_ENCODER=libx264` to force software encoding, or verify your FFmpeg build includes the hardware encoder. |
| Slash commands not appearing | Ensure the bot token has the `applications.commands` scope and is invited to the guild. Guild commands can take up to 1 minute to propagate. |

---

## Tests

```bash
npm test              # Run all tests (vitest)
npm run test:watch    # Watch mode
npm run typecheck     # Type-check without emitting
npm run lint          # Lint with Biome
```

---

## Technical Details

### FFmpeg Pipeline Flags

The FFmpeg pipeline is tuned for low-latency real-time streaming:

- **Input**: `-analyzeduration 2s -probesize 1MB -fflags nobuffer+genpts -flags low_delay`
- **Seek**: `-ss` placed before `-i` for fast keyframe seeking
- **HLS**: `-extension_picky 0` (FFmpeg 7+ only), reconnect flags disabled for HLS
- **Video**: `-tune zerolatency -refs 1 -bf 0 -g <fps>` (no B-frames, 1-second GOP)
- **Rate control**: `-bufsize:v` = target bitrate (1:1 ratio for tight CBR)
- **Audio**: `-application audio -vbr off -compression_level 5 -frame_duration 20`
- **Muxer**: NUT format with `-syncpoints none -write_index 0 -flush_packets 1`
- **Demuxer**: `node-av` NUT demuxer with 64KB read buffer, `fflags=nobuffer`
- **Bitstream filters**: `h264_mp4toannexb` → `h264_metadata aud=remove` → `dump_extra` (chained)

### Stremio Resolution Pipeline

Content resolution follows a four-step pipeline:

1. **Cinemeta search** — `GET /catalog/{type}/top/search={query}.json` → IMDB ID
2. **Torrentio streams** — `GET /stream/{type}/{imdbId}.json` → Real-Debrid resolve URLs
3. **RD resolution** — Follow redirect chain → direct download link
4. **Auto-play** — `GET /meta/series/{imdbId}.json` → episode list → find S:E+1 or S+1:E1

Series auto-play fetches the full episode list from Cinemeta's meta endpoint, finds the next episode (same season E+1, or first episode of next season), resolves it through Torrentio/Real-Debrid, and loops until the series ends or `--no-auto-play` is set.

### yt-dlp Integration

YouTube resolution uses three player clients (`mweb,ios,android_vr`) for reliable H.264 DASH stream availability. Format selection prefers separate video+audio HTTPS streams to avoid VP9/AV1 software decoding and AAC→Opus transcoding:

```
bv[vcodec~='^(avc|h264)'][height<=720]+ba[acodec=opus]  # H.264 video + Opus audio
/bv[vcodec~='^(avc|h264)'][height<=720]+ba              # H.264 video + any audio
/best[height<=720]                                       # Combined stream fallback
```

Sort preference: `res:720,codec:h264,acodec:opus,proto` — 720p H.264 with Opus over HTTPS.

### DAVE Encryption

The DAVE layer implements Discord's MLS-based E2EE protocol:

- MLS 1.0 with ciphersuite `DHKEMP256_AES128GCM_SHA256_P256`
- Per-sender key ratchets derived via `MLS-Exporter`
- Frame encryption with AES-128-GCM and truncated 64-bit auth tags
- Codec-aware encryption (H.264 NAL units have unencrypted ranges)
- Pre-allocated 16KB WASM heap buffers to avoid per-frame GC pressure
- Passthrough mode during MLS handshake for uninterrupted media flow

### Audio/Video Synchronization

Audio and video streams share a wall-clock reference (`ClockRef`) so that whichever stream processes its first frame establishes the common time baseline. Both streams pace themselves against their PTS (presentation timestamp) relative to this shared clock.

When video detects it is ahead of audio by more than 20ms, it adds the drift delta to its normal PTS-based sleep duration — a proportional correction that lets audio catch up without oscillation. Audio runs independently with its own PTS-based pacing (Opus 20ms frames).

### Precision Timing

The `BaseMediaStream` uses a hybrid sleep strategy to compensate for ARM's coarse `setTimeout` granularity (~4ms on Cortex-A57):

- **> 5ms**: `setTimeout` for the bulk, then spin-wait for the remainder
- **1-5ms**: Single `setImmediate` tick, then spin-wait
- **< 1ms**: Skip entirely (async yield overhead exceeds the wait)

### Process Lifecycle

FFmpeg child processes are guaranteed to be cleaned up in all exit paths:

- The stream loop uses a `finally` block that calls `pipeline.stop()` after every iteration (natural end, seek restart, error, or abort). `stop()` sends `SIGTERM` with a 2-second `SIGKILL` fallback.
- The media service explicitly destroys all PassThrough pipes and writable streams on completion, error, or abort. This unblocks the NUT demuxer's background packet loop, which then closes its native handles and bitstream filters.
- The global `SIGINT`/`SIGTERM` handler propagates an abort signal through the entire pipeline chain.

### Voice Gateway Close Code Handling

| Code | Classification | Action |
|------|---------------|--------|
| < 4000 | Resume | Reconnect and send Resume opcode |
| 4006 | Refresh | Request fresh connection via gateway |
| 4009 | Refresh | Request fresh connection via gateway |
| 4015 | Resume | Voice server crash — reconnect and resume |
| 4001-4005, 4007, 4011+ | Fatal | Emit fatal error; higher-level code retries |

### Gateway Close Code Handling

| Code | Classification | Action |
|------|---------------|--------|
| < 4000 | Resume | Reconnect to resume gateway URL |
| 4000-4003, 4005, 4008 | Resume | Reconnect and send Resume opcode |
| 4004 | Auth | Token rejected — fatal |
| 4007, 4009 | Identify | Must re-identify (new session) |
| 4010+ | Fatal | Emit fatal error |

---

## Protocol Compliance

All protocol implementations have been audited against their official documentation sources:

| Protocol | Documentation Source | Status |
|----------|---------------------|--------|
| Discord Voice Gateway v9 | [discord-userdoccers](https://github.com/discord-userdoccers/discord-userdoccers) | All 18 JSON opcodes (0-16, 21-24, 31) and 6 binary opcodes (25-30) verified |
| Discord Gateway v9 | [discord-api-docs](https://github.com/discord/discord-api-docs) | Opcodes 0-11, 18-22 verified. Slash command registration, intents, interaction handling verified |
| DAVE E2EE | [dave-protocol](https://github.com/discord/dave-protocol) + [libdave](https://github.com/discord/libdave) | MLS 1.0, P256_AES128GCM_SHA256_P256, key ratchets, epoch transitions verified |
| FFmpeg | [ffmpeg.org](https://ffmpeg.org/ffmpeg.html) | All encoder flags, filter syntax, muxer options, seek placement verified |
| yt-dlp | [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Format selection, extractor args (`mweb,ios,android_vr`), sort strings verified |
| RTP/SDP | RFC 3550, RFC 7587 | PT 120/101/102, profile-level-id=42e01f, header extensions, RTCP-FB verified |
