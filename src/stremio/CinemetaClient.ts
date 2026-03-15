/**
 * Client for the Cinemeta addon — the official Stremio metadata provider.
 *
 * Used to resolve a human-readable search query (e.g. "breaking bad") into
 * an IMDB ID that can be fed to Torrentio for stream resolution.
 *
 * Endpoint: https://v3-cinemeta.strem.io/catalog/{type}/top/search={query}.json
 */

import { Effect } from 'effect';
import { StremioError } from '../errors/index.js';
import type {
  CinemetaMeta,
  CinemetaSearchResult,
  ContentType,
} from './types.js';

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Search Cinemeta for content matching the given query.
 *
 * When `type` is not specified, both movies and series are searched and
 * results are merged (movies first, then series).
 */
export function searchCinemeta(
  query: string,
  type?: ContentType
): Effect.Effect<CinemetaMeta[], StremioError> {
  return Effect.gen(function* () {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new StremioError({ message: 'Search query must not be empty.' })
      );
    }

    const encoded = encodeURIComponent(trimmed);

    if (type) {
      return yield* fetchCatalog(type, encoded);
    }

    // Search both types concurrently and merge results.
    const [movies, series] = yield* Effect.all(
      [fetchCatalog('movie', encoded), fetchCatalog('series', encoded)],
      { concurrency: 2 }
    );

    return [...movies, ...series];
  });
}

/**
 * Fetch a single catalog search page.
 */
function fetchCatalog(
  type: ContentType,
  encodedQuery: string
): Effect.Effect<CinemetaMeta[], StremioError> {
  const url = `${CINEMETA_BASE}/catalog/${type}/top/search=${encodedQuery}.json`;

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(
          `Cinemeta returned HTTP ${response.status} for ${type} search.`
        );
      }

      const body = (await response.json()) as CinemetaSearchResult;
      return body.metas ?? [];
    },
    catch: (error) =>
      new StremioError({
        message: `Cinemeta search failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { type, url },
      }),
  });
}
