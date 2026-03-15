/**
 * High-level orchestrator for the live stream resolution pipeline.
 *
 * 1. Fetch schedule from DLStreams API
 * 2. Fuzzy-match user query to a scheduled event
 * 3. Resolve the matched channel to a server key
 * 4. Construct the final m3u8 URL with required headers
 *
 * Follows the same pattern as src/stremio/StremioResolver.ts.
 */

import { Effect } from 'effect';
import { LiveStreamError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';
import type { LiveSearchQuery, ResolvedLiveStream } from './types.js';
import {
  fetchSchedule,
  flattenSchedule,
  matchEvent,
  resolveStream,
} from './DlStreamsClient.js';

/**
 * Resolve a live event query into a streamable HLS URL.
 */
export function resolveLiveQuery(
  apiKey: string,
  search: LiveSearchQuery,
  logger: Logger,
  playerDomain?: string
): Effect.Effect<ResolvedLiveStream, LiveStreamError> {
  return Effect.gen(function* () {
    // ── Direct channel ID path ──────────────────────────────────────────
    if (search.channelId != null) {
      logger.info('Resolving stream for direct channel ID', {
        channelId: search.channelId,
      });

      const resolved = yield* resolveStream(
        search.channelId,
        apiKey,
        playerDomain
      );

      return {
        eventTitle: `Channel ${search.channelId}`,
        channelName: `Channel ${search.channelId}`,
        channelId: search.channelId,
        streamUrl: resolved.streamUrl,
        headers: resolved.headers,
      };
    }

    // ── Schedule search path ────────────────────────────────────────────
    const trimmed = search.query.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new LiveStreamError({
          message: 'Search query must not be empty.',
          details: { query: search.query },
        })
      );
    }

    // 1. Fetch schedule.
    logger.info('Fetching DLStreams schedule');
    const schedule = yield* fetchSchedule(apiKey);

    // 2. Flatten and match.
    const events = flattenSchedule(schedule);
    logger.info('Schedule loaded', {
      totalEvents: events.length,
      days: schedule.days_count,
    });

    const match = matchEvent(events, trimmed);

    if (!match) {
      return yield* Effect.fail(
        new LiveStreamError({
          message: `No live events found matching "${trimmed}".`,
          details: { query: trimmed, totalEvents: events.length },
        })
      );
    }

    logger.info('Event matched', {
      title: match.title,
      channelName: match.channelName,
      channelId: match.channelId,
      day: match.day,
      category: match.category,
      score: match.score,
    });

    // 3. Resolve stream URL.
    logger.info('Resolving stream server', { channelId: match.channelId });
    const resolved = yield* resolveStream(
      match.channelId,
      apiKey,
      playerDomain
    );

    logger.info('Stream resolved', {
      streamUrl: resolved.streamUrl.slice(0, 80) + '...',
    });

    return {
      eventTitle: match.title,
      channelName: match.channelName,
      channelId: match.channelId,
      streamUrl: resolved.streamUrl,
      headers: resolved.headers,
    };
  });
}
