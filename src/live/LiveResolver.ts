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
        const titles = events.map((e) => `  • ${e.sport}: ${e.title}`).join('\n');
        throw new Error(
          `No event matching "${trimmed}" found.\nAvailable events:\n${titles}`
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

// ── Team nickname / abbreviation map ────────────────────────────────────
// Maps common abbreviations and nicknames to tokens that appear in
// sportsurge event slugs (which use full team/city names).
// Only lowercase — lookups are case-insensitive via tokenize().
const TEAM_ALIASES: Record<string, string[]> = {
  // NHL
  avs: ['avalanche', 'colorado'],
  pens: ['penguins', 'pittsburgh'],
  caps: ['capitals', 'washington'],
  habs: ['canadiens', 'montreal'],
  bolts: ['lightning', 'tampa'],
  hawks: ['blackhawks', 'chicago'],
  nucks: ['canucks', 'vancouver'],
  sens: ['senators', 'ottawa'],
  wings: ['red', 'wings', 'detroit'],
  isles: ['islanders', 'new', 'york'],
  canes: ['hurricanes', 'carolina'],
  preds: ['predators', 'nashville'],
  jackets: ['blue', 'jackets', 'columbus'],
  leafs: ['maple', 'leafs', 'toronto'],
  bruins: ['bruins', 'boston'],
  rangers: ['rangers', 'new', 'york'],
  oilers: ['oilers', 'edmonton'],
  flames: ['flames', 'calgary'],
  sabres: ['sabres', 'buffalo'],
  stars: ['stars', 'dallas'],
  wild: ['wild', 'minnesota'],
  jets: ['jets', 'winnipeg'],
  kraken: ['kraken', 'seattle'],
  knights: ['golden', 'knights', 'vegas'],
  // NBA
  lakers: ['lakers', 'los', 'angeles'],
  celtics: ['celtics', 'boston'],
  sixers: ['76ers', 'philadelphia'],
  knicks: ['knicks', 'new', 'york'],
  dubs: ['warriors', 'golden', 'state'],
  mavs: ['mavericks', 'dallas'],
  nugs: ['nuggets', 'denver'],
  blazers: ['trail', 'blazers', 'portland'],
  clips: ['clippers', 'los', 'angeles'],
  grizz: ['grizzlies', 'memphis'],
  // NFL
  niners: ['49ers', 'san', 'francisco'],
  pats: ['patriots', 'new', 'england'],
  pack: ['packers', 'green', 'bay'],
  // MLB
  sox: ['sox', 'red', 'white'],
  yanks: ['yankees', 'new', 'york'],
  cards: ['cardinals', 'st', 'louis'],
  // Soccer
  barca: ['barcelona'],
  utd: ['united', 'manchester'],
  spurs: ['spurs', 'tottenham'],
  gunners: ['arsenal'],
  reds: ['liverpool'],
  blues: ['chelsea'],
  city: ['city', 'manchester'],
  psg: ['paris', 'saint', 'germain'],
  bayern: ['bayern', 'leverkusen'],
  juve: ['juventus'],
  real: ['real', 'madrid'],
  atleti: ['atletico', 'madrid'],
  // MMA / Boxing
  ufc: ['ufc'],
  // Shorthand sport names
  nhl: ['nhl'],
  nba: ['nba'],
  nfl: ['nfl'],
  mlb: ['mlb'],
  ucl: ['uefa', 'champions', 'league'],
  epl: ['premier', 'league'],
};

/**
 * Expand query tokens using the alias map.  If a query token matches
 * an alias key, the alias expansions are added alongside the original.
 */
function expandAliases(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const t of tokens) {
    expanded.push(t);
    const aliases = TEAM_ALIASES[t];
    if (aliases) {
      for (const a of aliases) {
        if (!expanded.includes(a)) expanded.push(a);
      }
    }
  }
  return expanded;
}

/**
 * Fuzzy-match a query against a list of events.
 *
 * Scoring:
 * - Exact token match: +3
 * - Substring match (min 3 chars on both sides): +1
 * - Alias-expanded tokens score the same as direct tokens
 *
 * Returns the best match, or undefined if score is 0.
 */
export function matchEvent(
  events: SportsurgeEvent[],
  query: string
): SportsurgeEvent | undefined {
  const rawTokens = tokenize(query);
  if (rawTokens.length === 0) return undefined;
  const queryTokens = expandAliases(rawTokens);

  let bestScore = 0;
  let bestMatch: SportsurgeEvent | undefined;

  for (const event of events) {
    const targetTokens = tokenize(`${event.title} ${event.sport}`);
    let score = 0;

    for (const qt of queryTokens) {
      for (const tt of targetTokens) {
        if (tt === qt) {
          // Exact match — strongest signal
          score += 3;
        } else if (qt.length >= 3 && tt.length >= 3) {
          // Substring match only when both tokens are meaningful length
          // to avoid false positives like "a" matching everything
          if (tt.includes(qt) || qt.includes(tt)) {
            score += 1;
          }
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
