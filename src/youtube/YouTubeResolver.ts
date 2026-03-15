/**
 * High-level orchestrator for the YouTube search → stream resolution pipeline.
 *
 * 1. Search YouTube for the user's query via yt-dlp
 * 2. Extract the direct stream URL from the best format
 * 3. Return the URL ready for `runStreamJob()` consumption
 *
 * Follows the same pattern as `src/stremio/StremioResolver.ts`.
 */

import { Effect } from 'effect';
import { YouTubeError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';
import { searchAndResolve } from './YtdlpClient.js';
import type { ResolvedYouTubeVideo } from './types.js';

/**
 * Search YouTube for a query and resolve a direct stream URL.
 */
export function resolveYouTubeQuery(
  ytdlpPath: string,
  query: string,
  logger: Logger
): Effect.Effect<ResolvedYouTubeVideo, YouTubeError> {
  return Effect.gen(function* () {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new YouTubeError({ message: 'Search query must not be empty.' })
      );
    }

    logger.info('Searching YouTube via yt-dlp', { query: trimmed });

    const resolved = yield* searchAndResolve(ytdlpPath, trimmed);

    logger.info('YouTube video matched', {
      title: resolved.title,
      videoId: resolved.videoId,
      channel: resolved.channel,
      durationSeconds: resolved.durationSeconds,
      webpageUrl: resolved.webpageUrl,
    });

    return resolved;
  });
}
