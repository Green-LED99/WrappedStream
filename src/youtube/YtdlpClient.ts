/**
 * yt-dlp child-process wrapper for searching YouTube and extracting
 * direct stream URLs.
 *
 * Follows the same spawn pattern as `src/media/Probe.ts`.
 */

import { spawn } from 'node:child_process';
import { Effect } from 'effect';
import { YouTubeError } from '../errors/index.js';
import type { YtdlpVideoInfo, ResolvedYouTubeVideo } from './types.js';

const YTDLP_TIMEOUT_MS = 30_000;

/**
 * Parse raw yt-dlp JSON output into a `ResolvedYouTubeVideo`.
 *
 * This is a pure function exported for testability — no I/O involved.
 */
export function parseYtdlpOutput(raw: string): ResolvedYouTubeVideo {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('yt-dlp returned empty output.');
  }

  const info: YtdlpVideoInfo = JSON.parse(trimmed);

  // When yt-dlp selects separate video+audio streams (bv+ba), the top-level
  // `url` is null and each stream URL lives in `requested_formats`.
  if (info.requested_formats && info.requested_formats.length >= 2) {
    // yt-dlp puts video first, audio second in requested_formats.
    const videoFormat = info.requested_formats.find(
      (f) => f.vcodec && f.vcodec !== 'none'
    );
    const audioFormat = info.requested_formats.find(
      (f) => f.acodec && f.acodec !== 'none'
    );

    if (!videoFormat?.url) {
      throw new Error(
        `yt-dlp returned split formats but no video URL for "${info.title ?? 'unknown'}".`
      );
    }

    return {
      videoId: info.id,
      title: info.title,
      webpageUrl: info.webpage_url,
      durationSeconds: info.duration,
      streamUrl: videoFormat.url,
      audioUrl: audioFormat?.url,
      channel: info.channel ?? info.uploader,
    };
  }

  // Single combined format — `url` is the direct stream URL.
  if (!info.url) {
    throw new Error(
      `yt-dlp returned metadata but no stream URL for "${info.title ?? 'unknown'}".`
    );
  }

  return {
    videoId: info.id,
    title: info.title,
    webpageUrl: info.webpage_url,
    durationSeconds: info.duration,
    streamUrl: info.url,
    channel: info.channel ?? info.uploader,
  };
}

/**
 * Search YouTube for a query and extract the direct stream URL
 * in a single yt-dlp invocation.
 *
 * Runs: `yt-dlp --dump-json --no-playlist -f "bv*[height<=1080]+ba/b" "ytsearch1:<query>"`
 *
 * The format selector picks separate video (≤1080p) + audio HTTPS streams,
 * falling back to a single combined stream. This avoids HLS manifests which
 * require YouTube-specific cookies that FFmpeg cannot provide.
 */
export function searchAndResolve(
  ytdlpPath: string,
  query: string
): Effect.Effect<ResolvedYouTubeVideo, YouTubeError> {
  return Effect.tryPromise({
    try: () => runYtdlp(ytdlpPath, query),
    catch: (error) =>
      new YouTubeError({
        message: error instanceof Error ? error.message : String(error),
        details: { query, ytdlpPath },
      }),
  });
}

async function runYtdlp(
  ytdlpPath: string,
  query: string
): Promise<ResolvedYouTubeVideo> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ytdlpPath,
      [
        '--dump-json',
        '--no-playlist',
        '-f',
        'bv*[height<=1080]+ba/b',
        `ytsearch1:${query}`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: YTDLP_TIMEOUT_MS,
      }
    );

    child.stdout.on('data', (chunk) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.from(chunk));
    });

    child.once('exit', (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }

      const stderrText = Buffer.concat(stderr).toString('utf8');
      reject(
        new Error(
          `yt-dlp exited with code ${code}: ${stderrText}`
        )
      );
    });

    child.once('error', (error) => {
      reject(new Error(`Unable to start yt-dlp: ${error.message}`));
    });
  });

  const raw = Buffer.concat(stdout).toString('utf8');

  if (raw.trim().length === 0) {
    throw new Error(`No results found for query "${query}".`);
  }

  return parseYtdlpOutput(raw);
}
