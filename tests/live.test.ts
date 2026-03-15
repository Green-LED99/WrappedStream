import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
  flattenSchedule,
  matchEvent,
  matchFreeEvent,
  parseFreeScheduleHtml,
  buildM3u8Url,
  buildStreamHeaders,
} from '../src/live/DlStreamsClient.js';
import { resolveLiveQuery } from '../src/live/LiveResolver.js';
import { createLogger } from '../src/utils/logger.js';
import type { DlStreamsScheduleResponse, FreeScheduleEvent, MatchedEvent } from '../src/live/types.js';

// ─── flattenSchedule ────────────────────────────────────────────────────────

describe('flattenSchedule', () => {
  it('flattens a multi-day, multi-category schedule', () => {
    const response: DlStreamsScheduleResponse = {
      success: true,
      data: {
        'Saturday 15th March': {
          'Ice Hockey': [
            {
              title: 'Dallas Stars vs Colorado Avalanche',
              channels: [{ channel_name: 'NHL Network', channel_id: 42 }],
              time: '20:00',
            },
          ],
          Soccer: [
            {
              title: 'Arsenal vs Chelsea',
              channels: [{ channel_name: 'Sky Sports', channel_id: 101 }],
              time: '15:00',
            },
          ],
        },
        'Sunday 16th March': {
          Basketball: [
            {
              title: 'Los Angeles Lakers vs Boston Celtics',
              channels: [{ channel_name: 'ESPN', channel_id: 55 }],
              time: '19:30',
            },
          ],
        },
      },
      count: 3,
      days_count: 2,
    };

    const events = flattenSchedule(response);
    expect(events).toHaveLength(3);

    expect(events[0]).toMatchObject({
      title: 'Dallas Stars vs Colorado Avalanche',
      channelName: 'NHL Network',
      channelId: 42,
      day: 'Saturday 15th March',
      category: 'Ice Hockey',
      score: 0,
    });

    expect(events[1]).toMatchObject({
      title: 'Arsenal vs Chelsea',
      channelId: 101,
    });

    expect(events[2]).toMatchObject({
      title: 'Los Angeles Lakers vs Boston Celtics',
      channelId: 55,
      day: 'Sunday 16th March',
      category: 'Basketball',
    });
  });

  it('handles empty schedule data', () => {
    const response: DlStreamsScheduleResponse = {
      success: true,
      data: {},
      count: 0,
      days_count: 0,
    };
    expect(flattenSchedule(response)).toEqual([]);
  });

  it('skips events with no channels', () => {
    const response: DlStreamsScheduleResponse = {
      success: true,
      data: {
        'Monday': {
          'Tennis': [
            {
              title: 'No Channel Event',
              channels: [],
            },
            {
              title: 'Has Channel',
              channels: [{ channel_name: 'ESPN', channel_id: 10 }],
            },
          ],
        },
      },
      count: 2,
      days_count: 1,
    };

    const events = flattenSchedule(response);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('Has Channel');
  });

  it('picks the first channel from events with multiple channels', () => {
    const response: DlStreamsScheduleResponse = {
      success: true,
      data: {
        'Monday': {
          'Soccer': [
            {
              title: 'Big Match',
              channels: [
                { channel_name: 'Sky Sports 1', channel_id: 100 },
                { channel_name: 'Sky Sports 2', channel_id: 200 },
              ],
            },
          ],
        },
      },
      count: 1,
      days_count: 1,
    };

    const events = flattenSchedule(response);
    expect(events).toHaveLength(1);
    expect(events[0]!.channelName).toBe('Sky Sports 1');
    expect(events[0]!.channelId).toBe(100);
  });

  it('strips </span> from category names', () => {
    const response: DlStreamsScheduleResponse = {
      success: true,
      data: {
        'Monday': {
          'Soccer</span>': [
            {
              title: 'Test Match',
              channels: [{ channel_name: 'ESPN', channel_id: 1 }],
            },
          ],
        },
      },
      count: 1,
      days_count: 1,
    };

    const events = flattenSchedule(response);
    expect(events[0]!.category).toBe('Soccer');
  });
});

// ─── matchEvent ─────────────────────────────────────────────────────────────

describe('matchEvent', () => {
  const sampleEvents: MatchedEvent[] = [
    {
      title: 'Dallas Stars vs Colorado Avalanche',
      channelName: 'NHL Network',
      channelId: 42,
      day: 'Saturday',
      category: 'Ice Hockey',
      score: 0,
    },
    {
      title: 'Los Angeles Lakers vs Boston Celtics',
      channelName: 'ESPN',
      channelId: 55,
      day: 'Sunday',
      category: 'Basketball',
      score: 0,
    },
    {
      title: 'Arsenal vs Chelsea',
      channelName: 'Sky Sports',
      channelId: 101,
      day: 'Saturday',
      category: 'Soccer',
      score: 0,
    },
  ];

  it('matches "stars game" to Dallas Stars event', () => {
    const result = matchEvent(sampleEvents, 'stars game');
    expect(result).toBeDefined();
    expect(result!.title).toBe('Dallas Stars vs Colorado Avalanche');
    expect(result!.score).toBeGreaterThan(0);
  });

  it('matches "lakers celtics" with multi-word query', () => {
    const result = matchEvent(sampleEvents, 'lakers celtics');
    expect(result).toBeDefined();
    expect(result!.title).toBe('Los Angeles Lakers vs Boston Celtics');
    expect(result!.score).toBeGreaterThanOrEqual(2);
  });

  it('matches case insensitively', () => {
    const result = matchEvent(sampleEvents, 'ARSENAL');
    expect(result).toBeDefined();
    expect(result!.title).toBe('Arsenal vs Chelsea');
  });

  it('returns undefined when no tokens match', () => {
    const result = matchEvent(sampleEvents, 'rugby world cup');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty query', () => {
    const result = matchEvent(sampleEvents, '');
    expect(result).toBeUndefined();
  });

  it('boosts score for category match', () => {
    // "hockey stars" should match Dallas Stars AND get a category bonus for "Ice Hockey"
    const result = matchEvent(sampleEvents, 'hockey stars');
    expect(result).toBeDefined();
    expect(result!.title).toBe('Dallas Stars vs Colorado Avalanche');
    // Score should be > 1 (1 for "stars" in title + 0.5 for "hockey" in category)
    expect(result!.score).toBeGreaterThan(1);
  });

  it('picks the highest-scoring match', () => {
    // "vs" appears in all titles; "celtics" only in one
    const result = matchEvent(sampleEvents, 'celtics vs');
    expect(result).toBeDefined();
    expect(result!.title).toBe('Los Angeles Lakers vs Boston Celtics');
  });
});

// ─── buildM3u8Url ───────────────────────────────────────────────────────────

describe('buildM3u8Url', () => {
  it('constructs correct URL from server key and channel ID', () => {
    const url = buildM3u8Url('abc123', 42);
    expect(url).toBe('https://abc123new.newkso.ru/abc123/premium42/mono.m3u8');
  });

  it('handles numeric-looking server key', () => {
    const url = buildM3u8Url('srv001', 1);
    expect(url).toBe('https://srv001new.newkso.ru/srv001/premium1/mono.m3u8');
  });
});

// ─── buildStreamHeaders ─────────────────────────────────────────────────────

describe('buildStreamHeaders', () => {
  it('returns Referer with trailing slash and Origin without', () => {
    const headers = buildStreamHeaders('https://cookiewebplay.xyz');
    expect(headers.Referer).toBe('https://cookiewebplay.xyz/');
    expect(headers.Origin).toBe('https://cookiewebplay.xyz');
  });

  it('strips trailing slashes from origin before constructing headers', () => {
    const headers = buildStreamHeaders('https://example.com///');
    expect(headers.Referer).toBe('https://example.com/');
    expect(headers.Origin).toBe('https://example.com');
  });
});

// ─── parseFreeScheduleHtml ──────────────────────────────────────────────────

describe('parseFreeScheduleHtml', () => {
  const sampleHtml = `
<div class="schedule__day"><div class="schedule__dayTitle">Sunday 15th March 2026</div>
<div class="schedule__events">
  <div class="schedule__event">
    <div class="schedule__eventHeader" data-title="[live] premier league : crystal palace - leeds united 10:00">
      <span class="schedule__time" data-time="10:00">10:00</span>
      <span class="schedule__eventTitle">[LIVE] PREMIER LEAGUE : Crystal Palace - Leeds United</span>
    </div>
    <div class="schedule__channels">
      <a href="/watchpulsematch.php?id=20567" data-ch="premier league stream">PREMIER LEAGUE Stream</a>
    </div>
  </div>
  <div class="schedule__event">
    <div class="schedule__eventHeader" data-title="[live] nba : lakers - celtics 19:30">
      <span class="schedule__time" data-time="19:30">19:30</span>
      <span class="schedule__eventTitle">[LIVE] NBA : Lakers - Celtics</span>
    </div>
    <div class="schedule__channels">
      <a href="/watchpulsematch.php?id=20574" data-ch="nba stream">NBA Stream</a>
    </div>
  </div>
</div></div>`;

  it('parses events from HTML with data attributes', () => {
    const events = parseFreeScheduleHtml(sampleHtml);
    expect(events).toHaveLength(2);
  });

  it('extracts title without [LIVE] prefix', () => {
    const events = parseFreeScheduleHtml(sampleHtml);
    expect(events[0]!.title).toBe('PREMIER LEAGUE : Crystal Palace - Leeds United');
  });

  it('extracts time from data-time attribute', () => {
    const events = parseFreeScheduleHtml(sampleHtml);
    expect(events[0]!.time).toBe('10:00');
    expect(events[1]!.time).toBe('19:30');
  });

  it('extracts watch URL from href', () => {
    const events = parseFreeScheduleHtml(sampleHtml);
    expect(events[0]!.watchUrl).toBe('/watchpulsematch.php?id=20567');
    expect(events[1]!.watchUrl).toBe('/watchpulsematch.php?id=20574');
  });

  it('extracts channel label from data-ch', () => {
    const events = parseFreeScheduleHtml(sampleHtml);
    expect(events[0]!.channelLabel).toBe('premier league stream');
    expect(events[1]!.channelLabel).toBe('nba stream');
  });

  it('initializes score to 0', () => {
    const events = parseFreeScheduleHtml(sampleHtml);
    expect(events[0]!.score).toBe(0);
  });

  it('handles empty HTML', () => {
    expect(parseFreeScheduleHtml('')).toEqual([]);
  });

  it('handles HTML with no matching events', () => {
    expect(parseFreeScheduleHtml('<div>No events today</div>')).toEqual([]);
  });
});

// ─── matchFreeEvent ────────────────────────────────────────────────────────

describe('matchFreeEvent', () => {
  const sampleEvents: FreeScheduleEvent[] = [
    {
      title: 'PREMIER LEAGUE : Crystal Palace - Leeds United',
      time: '10:00',
      channelLabel: 'premier league stream',
      watchUrl: '/watchpulsematch.php?id=20567',
      score: 0,
    },
    {
      title: 'NBA : Oklahoma City Thunder - Minnesota Timberwolves',
      time: '13:00',
      channelLabel: 'nba stream',
      watchUrl: '/watchpulsematch.php?id=20574',
      score: 0,
    },
    {
      title: 'MLB : Boston Red Sox - Minnesota Twins',
      time: '13:05',
      channelLabel: 'mlb stream',
      watchUrl: '/watchpulsematch.php?id=20576',
      score: 0,
    },
  ];

  it('matches "crystal palace" to Premier League event', () => {
    const result = matchFreeEvent(sampleEvents, 'crystal palace');
    expect(result).toBeDefined();
    expect(result!.title).toContain('Crystal Palace');
    expect(result!.score).toBeGreaterThan(0);
  });

  it('matches "thunder" to NBA event', () => {
    const result = matchFreeEvent(sampleEvents, 'thunder');
    expect(result).toBeDefined();
    expect(result!.title).toContain('Thunder');
  });

  it('matches case insensitively', () => {
    const result = matchFreeEvent(sampleEvents, 'RED SOX');
    expect(result).toBeDefined();
    expect(result!.title).toContain('Red Sox');
  });

  it('boosts score for channel label match', () => {
    // "nba thunder" should match OKC Thunder AND get bonus for "nba" in channelLabel
    const result = matchFreeEvent(sampleEvents, 'nba thunder');
    expect(result).toBeDefined();
    expect(result!.title).toContain('Thunder');
    expect(result!.score).toBeGreaterThan(1);
  });

  it('returns undefined for empty query', () => {
    expect(matchFreeEvent(sampleEvents, '')).toBeUndefined();
  });

  it('returns undefined when no tokens match', () => {
    expect(matchFreeEvent(sampleEvents, 'rugby')).toBeUndefined();
  });

  it('preserves watchUrl in the result', () => {
    const result = matchFreeEvent(sampleEvents, 'crystal palace');
    expect(result!.watchUrl).toBe('/watchpulsematch.php?id=20567');
  });
});

// ─── resolveLiveQuery ───────────────────────────────────────────────────────

describe('resolveLiveQuery', () => {
  it('fails with LiveStreamError for empty query without channelId', async () => {
    const logger = createLogger('error');
    await expect(
      Effect.runPromise(resolveLiveQuery('test-key', { query: '' }, logger))
    ).rejects.toThrow(/empty/i);
  });

  it('fails with LiveStreamError for whitespace-only query without channelId', async () => {
    const logger = createLogger('error');
    await expect(
      Effect.runPromise(resolveLiveQuery('test-key', { query: '   ' }, logger))
    ).rejects.toThrow(/empty/i);
  });
});
