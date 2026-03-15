/**
 * Client for the DLStreams (DaddyLive) API — schedule lookup, server key
 * resolution, and HLS stream URL construction.
 *
 * API base: https://dlstreams.top/daddyapi.php?key=KEY&endpoint=ENDPOINT
 *
 * Stream URL pattern (from MediaFusion / DaddyLive):
 *   https://{server_key}new.newkso.ru/{server_key}/premium{channel_id}/mono.m3u8
 *
 * The player domain (used for Referer headers and fallback server_lookup)
 * rotates frequently. It is read from the DLSTREAMS_PLAYER_DOMAIN env var
 * and defaults to a known-working domain.
 */

import { Effect } from 'effect';
import { LiveStreamError } from '../errors/index.js';
import type {
  DlStreamsScheduleResponse,
  DlStreamsEvent,
  FreeScheduleEvent,
  MatchedEvent,
  ResolvedLiveStream,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const API_BASE = 'https://dlstreams.top/daddyapi.php';
const SCHEDULE_TIMEOUT_MS = 15_000;
const SERVER_LOOKUP_TIMEOUT_MS = 10_000;

/** Known player domains to try for server_lookup fallback (in priority order). */
const FALLBACK_PLAYER_DOMAINS = [
  'cookiewebplay.xyz',
  'quest4play.xyz',
  'daddylivehd.sx',
  'sportkart.xyz',
];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// ─── Schedule ───────────────────────────────────────────────────────────────

/**
 * Fetch the event schedule from the DLStreams API.
 */
export function fetchSchedule(
  apiKey: string
): Effect.Effect<DlStreamsScheduleResponse, LiveStreamError> {
  const url = `${API_BASE}?key=${encodeURIComponent(apiKey)}&endpoint=schedule`;

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(SCHEDULE_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `DLStreams API returned HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }

      const body = (await response.json()) as DlStreamsScheduleResponse;

      if (body.success === false) {
        throw new Error('DLStreams API returned success=false');
      }

      return body;
    },
    catch: (error) =>
      new LiveStreamError({
        message: `Failed to fetch schedule: ${error instanceof Error ? error.message : String(error)}`,
        details: { url: url.replace(apiKey, '***') },
      }),
  });
}

// ─── Free schedule (no API key) ─────────────────────────────────────────────

const FREE_SCHEDULE_BASE = 'https://dlstreams.top/schedule-api.php';
const DLSTREAMS_ORIGIN = 'https://dlstreams.top';

/**
 * Fetch the free event schedule (no API key required).
 *
 * The free endpoint returns JSON `{ success, html }` where `html` is a
 * chunk of HTML with structured `data-*` attributes we can parse.
 *
 * @param source - Schedule source. `extra_plus` has major leagues (~30-40 events),
 *   `extra_topembed` has the largest selection (~500+ events). Default: `extra_plus`.
 */
export function fetchFreeSchedule(
  source: string = 'extra_plus'
): Effect.Effect<FreeScheduleEvent[], LiveStreamError> {
  const url = `${FREE_SCHEDULE_BASE}?source=${encodeURIComponent(source)}`;

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(SCHEDULE_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Free schedule endpoint returned HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }

      const body = (await response.json()) as { success: boolean; html: string };

      if (!body.success || !body.html) {
        throw new Error('Free schedule endpoint returned success=false or empty html');
      }

      return parseFreeScheduleHtml(body.html);
    },
    catch: (error) =>
      new LiveStreamError({
        message: `Failed to fetch free schedule: ${error instanceof Error ? error.message : String(error)}`,
        details: { url },
      }),
  });
}

/**
 * Parse the HTML from the free schedule endpoint into structured events.
 *
 * The HTML contains event blocks like:
 * ```html
 * <div class="schedule__eventHeader" data-title="[live] premier league : ...">
 *   <span class="schedule__time" data-time="10:00">10:00</span>
 *   <span class="schedule__eventTitle">[LIVE] PREMIER LEAGUE : ...</span>
 * </div>
 * <div class="schedule__channels">
 *   <a href="/watchpulsematch.php?id=20567" data-ch="premier league stream">...</a>
 * </div>
 * ```
 *
 * We match each eventHeader to its subsequent channels div.
 */
export function parseFreeScheduleHtml(html: string): FreeScheduleEvent[] {
  const events: FreeScheduleEvent[] = [];

  // Match event blocks: data-title on the header, then the first <a> inside the channels div.
  // We use a regex that captures the data-title, the event title from the span,
  // the time, and the channel link attributes.
  const eventPattern =
    /data-title="([^"]*)"[^]*?data-time="([^"]*)"[^]*?<span class="schedule__eventTitle">([^<]*)<\/span>[^]*?<a[^>]*href="(\/watch[^"]*)"[^>]*data-ch="([^"]*)"/g;

  let match: RegExpExecArray | null;
  while ((match = eventPattern.exec(html)) !== null) {
    const [, , time, rawTitle, watchUrl, channelLabel] = match;
    if (!rawTitle || !watchUrl) continue;

    // Clean up the title: strip [LIVE] prefix and extra whitespace.
    const title = rawTitle
      .replace(/^\[LIVE\]\s*/i, '')
      .trim();

    events.push({
      title,
      time: time ?? '',
      channelLabel: channelLabel ?? '',
      watchUrl,
      score: 0,
    });
  }

  return events;
}

/**
 * Fuzzy-match a query against free schedule events using word-overlap scoring.
 * Same algorithm as `matchEvent` but operates on `FreeScheduleEvent[]`.
 */
export function matchFreeEvent(
  events: FreeScheduleEvent[],
  query: string
): FreeScheduleEvent | undefined {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return undefined;

  let bestMatch: FreeScheduleEvent | undefined;
  let bestScore = 0;

  for (const event of events) {
    const titleTokens = tokenize(event.title);
    const labelTokens = tokenize(event.channelLabel);

    let score = 0;
    for (const qt of queryTokens) {
      if (titleTokens.some((tt) => tt.includes(qt) || qt.includes(tt))) {
        score += 1;
      }
      if (labelTokens.some((lt) => lt.includes(qt) || qt.includes(lt))) {
        score += 0.5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { ...event, score };
    }
  }

  return bestMatch;
}

/**
 * Resolve a DLStreams watch page URL to a DaddyLive channel ID.
 *
 * The watch page embeds an iframe like:
 *   `<iframe id="playerFrame" src="https://embedhd.org/source/fetch.php?hd=17">`
 *
 * The `hd` parameter is the DaddyLive channel ID used for server_lookup.
 */
export function resolveWatchPageChannelId(
  watchUrl: string
): Effect.Effect<number, LiveStreamError> {
  const fullUrl = watchUrl.startsWith('http') ? watchUrl : `${DLSTREAMS_ORIGIN}${watchUrl}`;

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(fullUrl, {
        signal: AbortSignal.timeout(SERVER_LOOKUP_TIMEOUT_MS),
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Referer: `${DLSTREAMS_ORIGIN}/`,
        },
      });

      if (!response.ok) {
        throw new Error(`Watch page returned HTTP ${response.status}`);
      }

      const html = await response.text();

      // Extract hd=N from iframe src (e.g., src="https://embedhd.org/source/fetch.php?hd=17")
      const hdMatch = html.match(/src="[^"]*[?&]hd=(\d+)"/);
      if (hdMatch?.[1]) {
        return parseInt(hdMatch[1], 10);
      }

      // Fallback: look for channel_id or channelKey patterns in scripts
      const channelMatch = html.match(/channel_id[=:]\s*["']?(\d+)["']?/);
      if (channelMatch?.[1]) {
        return parseInt(channelMatch[1], 10);
      }

      throw new Error(
        'Could not extract DaddyLive channel ID from watch page. ' +
          'The page structure may have changed.'
      );
    },
    catch: (error) =>
      new LiveStreamError({
        message: `Failed to resolve watch page channel ID: ${error instanceof Error ? error.message : String(error)}`,
        details: { watchUrl: fullUrl },
      }),
  });
}

// ─── Schedule flattening (pure) ─────────────────────────────────────────────

/**
 * Flatten the nested schedule response into a searchable array of events.
 *
 * Input shape: `{ data: { [day]: { [category]: DlStreamsEvent[] } } }`
 * Output: flat `MatchedEvent[]` with day/category metadata and score=0.
 */
export function flattenSchedule(
  response: DlStreamsScheduleResponse
): MatchedEvent[] {
  const events: MatchedEvent[] = [];

  if (!response.data || typeof response.data !== 'object') {
    return events;
  }

  for (const [day, categories] of Object.entries(response.data)) {
    if (!categories || typeof categories !== 'object') continue;

    for (const [category, eventList] of Object.entries(categories)) {
      if (!Array.isArray(eventList)) continue;

      for (const event of eventList) {
        if (!event.channels || !Array.isArray(event.channels) || event.channels.length === 0) {
          continue;
        }

        // Pick the first channel for this event.
        const channel = event.channels[0]!;
        if (!channel.channel_name || channel.channel_id == null) continue;

        events.push({
          title: event.title ?? '',
          channelName: channel.channel_name,
          channelId: Number(channel.channel_id),
          day,
          category: category.replace('</span>', ''),
          score: 0,
        });
      }
    }
  }

  return events;
}

// ─── Fuzzy matching (pure) ──────────────────────────────────────────────────

/**
 * Tokenize a string into lowercase word tokens.
 * Splits on whitespace, punctuation, and common separators.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_.,;:!?()[\]{}|\/\\@#$%^&*+=<>"'`~]+/)
    .filter((t) => t.length > 0);
}

/**
 * Fuzzy-match a query against a list of events using word-overlap scoring.
 *
 * For each event:
 *   - score += 1 for each query token found in the title tokens
 *   - score += 0.5 for each query token found in the category
 *
 * Returns the highest-scoring event, or `undefined` if no tokens match.
 */
export function matchEvent(
  events: MatchedEvent[],
  query: string
): MatchedEvent | undefined {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return undefined;

  let bestMatch: MatchedEvent | undefined;
  let bestScore = 0;

  for (const event of events) {
    const titleTokens = tokenize(event.title);
    const categoryTokens = tokenize(event.category);

    let score = 0;
    for (const qt of queryTokens) {
      // Check title tokens — substring match for partial names.
      if (titleTokens.some((tt) => tt.includes(qt) || qt.includes(tt))) {
        score += 1;
      }
      // Bonus for matching category.
      if (categoryTokens.some((ct) => ct.includes(qt) || qt.includes(ct))) {
        score += 0.5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { ...event, score };
    }
  }

  return bestMatch;
}

// ─── Server key resolution ──────────────────────────────────────────────────

/**
 * Resolve a channel ID to a server key using the DLStreams API.
 *
 * Tries the API `server_lookup` endpoint first (behind the API key).
 * If the API doesn't support that endpoint, falls back to direct
 * player domain server_lookup.
 */
export function resolveServerKey(
  channelId: number,
  apiKey: string,
  playerDomain?: string
): Effect.Effect<{ serverKey: string; playerOrigin: string }, LiveStreamError> {
  return Effect.tryPromise({
    try: async () => {
      // 1. Try the DLStreams API server_lookup endpoint.
      const apiResult = await tryApiServerLookup(channelId, apiKey);
      if (apiResult) {
        return {
          serverKey: apiResult,
          playerOrigin: playerDomain
            ? `https://${playerDomain}`
            : `https://${FALLBACK_PLAYER_DOMAINS[0]}`,
        };
      }

      // 2. Fall back to direct player domain server_lookup.
      const domains = playerDomain
        ? [playerDomain, ...FALLBACK_PLAYER_DOMAINS.filter((d) => d !== playerDomain)]
        : FALLBACK_PLAYER_DOMAINS;

      for (const domain of domains) {
        const result = await tryPlayerDomainServerLookup(channelId, domain);
        if (result) {
          return { serverKey: result, playerOrigin: `https://${domain}` };
        }
      }

      throw new Error(
        `Unable to resolve server key for channel ${channelId}. ` +
          `Tried API and ${domains.length} player domains.`
      );
    },
    catch: (error) =>
      new LiveStreamError({
        message: `Server key resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { channelId },
      }),
  });
}

/**
 * Try the DLStreams API server_lookup endpoint.
 * Returns the server_key or null if the endpoint doesn't exist.
 */
async function tryApiServerLookup(
  channelId: number,
  apiKey: string
): Promise<string | null> {
  try {
    const url = `${API_BASE}?key=${encodeURIComponent(apiKey)}&endpoint=server_lookup&channel_id=premium${channelId}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(SERVER_LOOKUP_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return null;

    const data = (await response.json()) as { server_key?: string };
    return data.server_key ?? null;
  } catch {
    return null;
  }
}

/**
 * Try server_lookup on a specific player domain.
 *
 * Uses the same headers as MediaFusion:
 *   Referer: https://{domain}/premiumtv/daddylivehd.php?id={channelId}
 *   User-Agent: Chrome
 */
async function tryPlayerDomainServerLookup(
  channelId: number,
  domain: string
): Promise<string | null> {
  try {
    const url = `https://${domain}/server_lookup.php?channel_id=premium${channelId}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(SERVER_LOOKUP_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        Referer: `https://${domain}/premiumtv/daddylivehd.php?id=${channelId}`,
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return null;

    const data = (await response.json()) as { server_key?: string };
    if (!data.server_key || data.server_key === 'top1/cdn') return null;

    return data.server_key;
  } catch {
    return null;
  }
}

// ─── URL construction (pure) ────────────────────────────────────────────────

/**
 * Construct the m3u8 stream URL from a server key and channel ID.
 *
 * Pattern: https://{serverKey}new.newkso.ru/{serverKey}/premium{channelId}/mono.m3u8
 */
export function buildM3u8Url(serverKey: string, channelId: number): string {
  return `https://${serverKey}new.newkso.ru/${serverKey}/premium${channelId}/mono.m3u8`;
}

/**
 * Build the HTTP headers required for HLS playback.
 *
 * The m3u8 stream requires a Referer and Origin header matching the
 * player domain that served the stream.
 */
export function buildStreamHeaders(playerOrigin: string): Record<string, string> {
  const origin = playerOrigin.replace(/\/+$/, '');
  return {
    Referer: `${origin}/`,
    Origin: origin,
  };
}

/**
 * Full resolution: channel ID → resolved live stream with m3u8 URL and headers.
 */
export function resolveStream(
  channelId: number,
  apiKey: string,
  playerDomain?: string
): Effect.Effect<{ streamUrl: string; headers: Record<string, string> }, LiveStreamError> {
  return Effect.gen(function* () {
    const { serverKey, playerOrigin } = yield* resolveServerKey(
      channelId,
      apiKey,
      playerDomain
    );
    const streamUrl = buildM3u8Url(serverKey, channelId);
    const headers = buildStreamHeaders(playerOrigin);
    return { streamUrl, headers };
  });
}
