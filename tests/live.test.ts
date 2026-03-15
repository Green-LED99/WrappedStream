import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
  flattenSchedule,
  matchEvent,
  buildM3u8Url,
  buildStreamHeaders,
} from '../src/live/DlStreamsClient.js';
import { resolveLiveQuery } from '../src/live/LiveResolver.js';
import { createLogger } from '../src/utils/logger.js';
import type { DlStreamsScheduleResponse, MatchedEvent } from '../src/live/types.js';

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
