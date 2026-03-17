/**
 * High-level orchestrator for the Stremio search → stream resolution pipeline.
 *
 * 1. Search Cinemeta for the user's query → get IMDB IDs
 * 2. Query Torrentio RD for streams → get resolve URLs
 * 3. Resolve the RD URL → get a direct download link
 * 4. Return the link ready for `play-url` pipeline consumption
 */

import { Effect } from 'effect';
import { StremioError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';
import { searchCinemeta } from './CinemetaClient.js';
import {
  addonBaseFromManifest,
  resolveContent,
} from './TorrentioClient.js';
import type { ContentType, ResolvedStream, SearchQuery } from './types.js';

/**
 * Resolve a search query into a playable Real-Debrid stream URL.
 */
export function resolveSearchQuery(
  addonManifestUrl: string,
  search: SearchQuery,
  logger: Logger
): Effect.Effect<ResolvedStream, StremioError> {
  return Effect.gen(function* () {
    const addonBase = addonBaseFromManifest(addonManifestUrl);

    // 1. Search Cinemeta
    logger.info('Searching Cinemeta', {
      query: search.query,
      type: search.type ?? 'all',
    });
    const results = yield* searchCinemeta(search.query, search.type);

    if (results.length === 0) {
      return yield* Effect.fail(
        new StremioError({
          message: `No results found for "${search.query}".`,
          details: { query: search.query, type: search.type },
        })
      );
    }

    // Pick the first result.
    const match = results[0]!;
    const contentType: ContentType = match.type;

    logger.info('Content matched', {
      name: match.name,
      imdbId: match.imdb_id,
      type: contentType,
      year: match.year ?? match.releaseInfo,
    });

    // For series, season and episode are required.
    if (contentType === 'series') {
      if (search.season == null || search.episode == null) {
        return yield* Effect.fail(
          new StremioError({
            message: `"${match.name}" is a series. Please specify --season and --episode.`,
            details: {
              name: match.name,
              imdbId: match.imdb_id,
              type: contentType,
            },
          })
        );
      }

      logger.info('Resolving series episode', {
        season: search.season,
        episode: search.episode,
      });
    }

    // 2–3. Fetch streams from Torrentio and resolve the RD URL.
    logger.info('Fetching streams from Torrentio', {
      imdbId: match.imdb_id,
      type: contentType,
    });

    const resolved = yield* resolveContent(
      addonBase,
      contentType,
      match.imdb_id,
      match.name,
      search.season,
      search.episode
    );

    logger.info('Stream resolved', {
      quality: resolved.quality,
      filename: resolved.filename,
      url: resolved.streamUrl.slice(0, 80) + '...',
    });

    // Attach series context for auto-play-next.
    if (contentType === 'series' && search.season != null && search.episode != null) {
      resolved.season = search.season;
      resolved.episode = search.episode;
      resolved.addonBase = addonBase;
    }

    return resolved;
  });
}
