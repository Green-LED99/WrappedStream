# ── Stage 1: Build ────────────────────────────────────────────
# Install ALL dependencies (including devDependencies) and compile
# TypeScript.  Native addons (node-datachannel, node-av) are built
# or downloaded here; cmake + g++ are available in case prebuilts
# are missing for the target architecture.
FROM node:22-bookworm AS build

# Build tools needed if node-datachannel has no prebuilt binary for
# this platform and must compile from source via cmake-js.
RUN apt-get update && apt-get install -y --no-install-recommends \
        cmake \
        g++ \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching — only re-runs when
# package.json or lockfile change).
COPY package.json package-lock.json ./
RUN npm ci

# Copy source, vendored WASM, and build config, then compile.
COPY tsconfig.json ./
COPY src/ src/
COPY vendor/ vendor/
COPY tests/ tests/
COPY vitest.config.ts ./

RUN npx tsc -p tsconfig.json


# ── Stage 2: Runtime ──────────────────────────────────────────
# Slim image with only production deps + FFmpeg + yt-dlp.
FROM node:22-bookworm-slim AS runtime

# FFmpeg with libx264 (H.264) and libopus (Opus).
# python3 + pip for yt-dlp (required by play-youtube).
# ca-certificates for HTTPS fetches (HLS segments, sportsurge, etc.).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
    && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp \
    && apt-get purge -y python3-pip python3-venv \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production-only npm install (skip devDependencies).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output + vendored WASM from the build stage.
COPY --from=build /app/dist/ dist/
COPY vendor/ vendor/

# Default environment.  Override at runtime with -e or --env-file.
ENV LOG_LEVEL=info \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe \
    YTDLP_PATH=yt-dlp

ENTRYPOINT ["node", "dist/src/index.js"]
CMD ["play-url"]
