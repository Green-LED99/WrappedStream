/**
 * Client for the Torrentio addon with Real-Debrid integration.
 *
 * Given an IMDB ID, queries the Torrentio addon for available streams and
 * resolves the top result's `/resolve/realdebrid/…` URL into a direct
 * download link that can be piped through FFmpeg.
 *
 * The addon URL (including quality filters and RD API key) is provided via
 * the `STREMIO_ADDON_URL` environment variable — the full manifest URL from
 * the Torrentio configuration page.
 */

import { Effect } from 'effect';
import { StremioError } from '../errors/index.js';
import type {
  ContentType,
  ResolvedStream,
  TorrentioStream,
  TorrentioStreamResponse,
} from './types.js';

const STREAM_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 30_000;

/**
 * Derive the addon base URL from a full manifest URL.
 *
 * Example input:
 *   https://torrentio.strem.fun/config.../manifest.json
 * Returns:
 *   https://torrentio.strem.fun/config...
 */
export function addonBaseFromManifest(manifestUrl: string): string {
  const url = manifestUrl.replace(/\/manifest\.json\s*$/i, '');
  // Strip any trailing slash for consistency.
  return url.replace(/\/+$/, '');
}

/**
 * Build the Stremio stream endpoint URL.
 *
 * For movies:  /stream/movie/tt0468569.json
 * For series:  /stream/series/tt0903747:1:1.json
 */
export function buildStreamUrl(
  addonBase: string,
  type: ContentType,
  imdbId: string,
  season?: number,
  episode?: number
): string {
  let id = imdbId;
  if (type === 'series' && season != null && episode != null) {
    id = `${imdbId}:${season}:${episode}`;
  }
  return `${addonBase}/stream/${type}/${id}.json`;
}

/**
 * Fetch available streams from Torrentio for the given content.
 */
export function fetchStreams(
  addonBase: string,
  type: ContentType,
  imdbId: string,
  season?: number,
  episode?: number
): Effect.Effect<TorrentioStream[], StremioError> {
  const url = buildStreamUrl(addonBase, type, imdbId, season, episode);

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(
          `Torrentio returned HTTP ${response.status} for ${url}`
        );
      }

      const body = (await response.json()) as TorrentioStreamResponse;

      if (!body.streams || body.streams.length === 0) {
        throw new Error(
          `No streams found for ${type} ${imdbId}${season != null ? ` S${season}E${episode}` : ''}.`
        );
      }

      return body.streams;
    },
    catch: (error) =>
      new StremioError({
        message: `Torrentio stream fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { url, type, imdbId },
      }),
  });
}

/**
 * Resolve a Torrentio `/resolve/realdebrid/…` URL into a direct download link.
 *
 * The resolve endpoint returns a 302 redirect to the actual Real-Debrid CDN URL.
 * We follow the redirect chain and return the final URL.
 */
export function resolveStreamUrl(
  torrentioUrl: string
): Effect.Effect<string, StremioError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(torrentioUrl, {
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        redirect: 'follow',
      });

      // After following redirects, the final URL is the RD download link.
      // Some resolve endpoints return the URL in a JSON body instead of redirecting.
      if (
        response.headers.get('content-type')?.includes('application/json')
      ) {
        const body = (await response.json()) as { url?: string };
        if (body.url) {
          return body.url;
        }
      }

      // If the redirect was followed, response.url is the final destination.
      if (response.url && response.url !== torrentioUrl) {
        return response.url;
      }

      // Fallback: read body as text — some RD resolvers return a plain URL.
      const text = await response.text();
      const trimmed = text.trim();
      if (trimmed.startsWith('http')) {
        return trimmed;
      }

      throw new Error(
        `Unable to resolve stream URL. Status: ${response.status}, body length: ${trimmed.length}`
      );
    },
    catch: (error) =>
      new StremioError({
        message: `Failed to resolve Real-Debrid stream: ${error instanceof Error ? error.message : String(error)}`,
        details: { torrentioUrl },
      }),
  });
}

/**
 * Parse quality information from a Torrentio stream name.
 *
 * The name field typically looks like "[RD+] Torrentio\n1080p".
 */
export function parseQuality(stream: TorrentioStream): string {
  const lines = stream.name.split('\n');
  const last = lines[lines.length - 1]?.trim();
  return last || 'unknown';
}

/**
 * High-level: resolve a search result + stream selection into a playable URL.
 */
export function resolveContent(
  addonBase: string,
  type: ContentType,
  imdbId: string,
  contentName: string,
  season?: number,
  episode?: number
): Effect.Effect<ResolvedStream, StremioError> {
  return Effect.gen(function* () {
    const streams = yield* fetchStreams(addonBase, type, imdbId, season, episode);

    // Pick the first stream — Torrentio sorts by quality/availability.
    const best = streams[0]!;
    const quality = parseQuality(best);
    const directUrl = yield* resolveStreamUrl(best.url);

    return {
      imdbId,
      contentName,
      contentType: type,
      streamTitle: best.title,
      streamUrl: directUrl,
      filename: best.behaviorHints?.filename,
      quality,
    };
  });
}
