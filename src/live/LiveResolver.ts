import { Effect } from 'effect';
import { LiveStreamError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';
import type { SportsurgeEvent, ResolvedLiveStream } from './types.js';
import {
  fetchEvents,
  fetchStreamEmbedId,
  resolveStreamUrl,
} from './SportsurgeClient.js';

/**
 * Resolve a search query to a live stream URL from sportsurge.ws.
 *
 * 1. Fetches all events from the homepage
 * 2. Fuzzy-matches the query against event titles + sport
 * 3. Extracts the stream embed ID from the event page
 * 4. Resolves the embed to a direct HLS playlist URL
 */
export function resolveLiveQuery(
  query: string,
  logger: Logger
): Effect.Effect<ResolvedLiveStream, LiveStreamError> {
  return Effect.tryPromise({
    try: async () => {
      const trimmed = query.trim();
      if (!trimmed) {
        throw new Error('Search query must not be empty');
      }

      // 1. Fetch events
      logger.info('Fetching events from sportsurge.ws');
      const events = await fetchEvents();
      logger.info('Events loaded', { count: events.length });

      if (events.length === 0) {
        throw new Error('No events found on sportsurge.ws');
      }

      // 2. Fuzzy match
      const best = matchEvent(events, trimmed);
      if (!best) {
        throw new Error(
          `No event matching "${trimmed}" found among ${events.length} events`
        );
      }

      logger.info('Event matched', {
        title: best.title,
        sport: best.sport,
        url: best.url,
      });

      // 3. Get stream embed ID
      logger.info('Fetching stream embed ID');
      const streamId = await fetchStreamEmbedId(best.url);
      logger.info('Stream embed ID', { streamId });

      // 4. Resolve to HLS URL
      logger.info('Resolving stream URL');
      const resolved = await resolveStreamUrl(streamId);
      logger.info('Stream resolved', {
        streamUrl: resolved.streamUrl.slice(0, 80) + '...',
      });

      return {
        eventTitle: best.title,
        sport: best.sport,
        streamUrl: resolved.streamUrl,
        headers: resolved.headers,
      };
    },
    catch: (error) =>
      new LiveStreamError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });
}

/**
 * Fuzzy-match a query against a list of events.
 * Scores by word overlap between query tokens and event title + sport.
 * Returns the best match, or undefined if no tokens overlap.
 */
export function matchEvent(
  events: SportsurgeEvent[],
  query: string
): SportsurgeEvent | undefined {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return undefined;

  let bestScore = 0;
  let bestMatch: SportsurgeEvent | undefined;

  for (const event of events) {
    const targetTokens = tokenize(`${event.title} ${event.sport}`);
    let score = 0;

    for (const qt of queryTokens) {
      for (const tt of targetTokens) {
        if (tt === qt) {
          score += 2;
        } else if (tt.includes(qt) || qt.includes(tt)) {
          score += 1;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = event;
    }
  }

  return bestScore > 0 ? bestMatch : undefined;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((t) => t.length > 0);
}
