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
  CinemetaMetaDetail,
  CinemetaSearchResult,
  CinemetaVideo,
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
 * Fetch full series metadata including all episodes.
 *
 * Endpoint: https://v3-cinemeta.strem.io/meta/series/{imdbId}.json
 */
export function fetchSeriesMeta(
  imdbId: string
): Effect.Effect<CinemetaMetaDetail, StremioError> {
  const url = `${CINEMETA_BASE}/meta/series/${imdbId}.json`;

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(
          `Cinemeta returned HTTP ${response.status} for series meta ${imdbId}.`
        );
      }

      return (await response.json()) as CinemetaMetaDetail;
    },
    catch: (error) =>
      new StremioError({
        message: `Cinemeta series meta fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { imdbId, url },
      }),
  });
}

/**
 * Find the next episode after the given season/episode.
 *
 * Looks for S:E+1 first, then S+1:E1 if at the end of a season.
 * Returns null if no more episodes exist.
 */
export function getNextEpisode(
  videos: CinemetaVideo[],
  currentSeason: number,
  currentEpisode: number
): { season: number; episode: number } | null {
  // Try next episode in same season.
  const nextInSeason = videos.find(
    (v) => v.season === currentSeason && v.episode === currentEpisode + 1
  );
  if (nextInSeason) {
    return { season: nextInSeason.season, episode: nextInSeason.episode };
  }

  // Try first episode of next season.
  const nextSeasonEps = videos
    .filter((v) => v.season === currentSeason + 1)
    .sort((a, b) => a.episode - b.episode);
  if (nextSeasonEps.length > 0) {
    return { season: nextSeasonEps[0]!.season, episode: nextSeasonEps[0]!.episode };
  }

  return null;
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
