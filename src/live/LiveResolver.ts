/**
 * High-level orchestrator for the live stream resolution pipeline.
 *
 * Supports two schedule sources:
 *   1. **API schedule** (requires API key): structured JSON from daddyapi.php
 *   2. **Free schedule** (no API key): HTML scraping from schedule-api.php
 *
 * Flow:
 *   1. Fetch schedule (API or free)
 *   2. Fuzzy-match user query to a scheduled event
 *   3. Resolve the matched channel to a server key
 *   4. Construct the final m3u8 URL with required headers
 *
 * Follows the same pattern as src/stremio/StremioResolver.ts.
 */

import { Effect } from 'effect';
import { LiveStreamError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';
import type { LiveSearchQuery, ResolvedLiveStream } from './types.js';
import {
  fetchSchedule,
  fetchFreeSchedule,
  flattenSchedule,
  matchEvent,
  matchFreeEvent,
  resolveStream,
  resolveWatchPageChannelId,
} from './DlStreamsClient.js';

/**
 * Resolve a live event query into a streamable HLS URL.
 *
 * When `apiKey` is provided, uses the structured API schedule endpoint.
 * When `apiKey` is empty/undefined, falls back to the free schedule endpoint
 * which requires an extra step to resolve watch page URLs to channel IDs.
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

    // Route to either API or free schedule based on API key availability.
    const useApi = apiKey.length > 0;

    let matchedChannelId: number;
    let matchTitle: string;
    let matchChannelName: string;
    let matchScore: number;

    if (useApi) {
      // ── API schedule path ───────────────────────────────────────────
      logger.info('Fetching DLStreams schedule (API)');
      const schedule = yield* fetchSchedule(apiKey);

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

      logger.info('Event matched (API)', {
        title: match.title,
        channelName: match.channelName,
        channelId: match.channelId,
        day: match.day,
        category: match.category,
        score: match.score,
      });

      matchedChannelId = match.channelId;
      matchTitle = match.title;
      matchChannelName = match.channelName;
      matchScore = match.score;
    } else {
      // ── Free schedule path ──────────────────────────────────────────
      logger.info('Fetching DLStreams schedule (free — no API key)');
      const freeEvents = yield* fetchFreeSchedule();

      logger.info('Free schedule loaded', {
        totalEvents: freeEvents.length,
      });

      const match = matchFreeEvent(freeEvents, trimmed);

      if (!match) {
        return yield* Effect.fail(
          new LiveStreamError({
            message: `No live events found matching "${trimmed}".`,
            details: { query: trimmed, totalEvents: freeEvents.length },
          })
        );
      }

      logger.info('Event matched (free schedule)', {
        title: match.title,
        channelLabel: match.channelLabel,
        watchUrl: match.watchUrl,
        score: match.score,
      });

      // Resolve the watch page URL to a DaddyLive channel ID.
      logger.info('Resolving watch page to channel ID', {
        watchUrl: match.watchUrl,
      });
      matchedChannelId = yield* resolveWatchPageChannelId(match.watchUrl);

      logger.info('Watch page resolved to channel ID', {
        channelId: matchedChannelId,
      });

      matchTitle = match.title;
      matchChannelName = match.channelLabel;
      matchScore = match.score;
    }

    // ── Resolve stream URL (shared path) ────────────────────────────────
    logger.info('Resolving stream server', { channelId: matchedChannelId });
    const resolved = yield* resolveStream(
      matchedChannelId,
      apiKey,
      playerDomain
    );

    logger.info('Stream resolved', {
      streamUrl: resolved.streamUrl.slice(0, 80) + '...',
    });

    return {
      eventTitle: matchTitle,
      channelName: matchChannelName,
      channelId: matchedChannelId,
      streamUrl: resolved.streamUrl,
      headers: resolved.headers,
    };
  });
}
