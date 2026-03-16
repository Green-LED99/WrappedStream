import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { matchEvent } from '../src/live/LiveResolver.js';
import { buildFfmpegNutArgs } from '../src/media/FFmpegPipeline.js';
import { resolveLiveQuery } from '../src/live/LiveResolver.js';
import type { SportsurgeEvent } from '../src/live/types.js';

const sampleEvents: SportsurgeEvent[] = [
  {
    url: 'https://sportsurge.ws/watch/nba/golden-state-warriors-new-york-knicks/12345',
    title: 'Golden State Warriors New York Knicks',
    sport: 'nba',
  },
  {
    url: 'https://sportsurge.ws/watch/nhl/toronto-maple-leafs-minnesota-wild/67890',
    title: 'Toronto Maple Leafs Minnesota Wild',
    sport: 'nhl',
  },
  {
    url: 'https://sportsurge.ws/watch/mlb/los-angeles-dodgers-chicago-cubs/11111',
    title: 'Los Angeles Dodgers Chicago Cubs',
    sport: 'mlb',
  },
  {
    url: 'https://sportsurge.ws/watch/nfl/kansas-city-chiefs-san-francisco-49ers/22222',
    title: 'Kansas City Chiefs San Francisco 49ers',
    sport: 'nfl',
  },
];

describe('matchEvent', () => {
  it('matches by team name', () => {
    const result = matchEvent(sampleEvents, 'knicks');
    expect(result?.title).toBe('Golden State Warriors New York Knicks');
  });

  it('matches case insensitively', () => {
    const result = matchEvent(sampleEvents, 'MAPLE LEAFS');
    expect(result?.title).toBe('Toronto Maple Leafs Minnesota Wild');
  });

  it('matches multi-word queries', () => {
    const result = matchEvent(sampleEvents, 'golden state warriors');
    expect(result?.title).toBe('Golden State Warriors New York Knicks');
  });

  it('matches by sport name', () => {
    const result = matchEvent(sampleEvents, 'nhl wild');
    expect(result?.title).toBe('Toronto Maple Leafs Minnesota Wild');
  });

  it('returns undefined when no match', () => {
    const result = matchEvent(sampleEvents, 'cricket');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty query', () => {
    const result = matchEvent(sampleEvents, '');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty events array', () => {
    const result = matchEvent([], 'knicks');
    expect(result).toBeUndefined();
  });

  it('prefers exact token matches over substring matches', () => {
    const result = matchEvent(sampleEvents, 'chiefs 49ers');
    expect(result?.title).toBe('Kansas City Chiefs San Francisco 49ers');
  });
});

describe('buildFfmpegNutArgs', () => {
  const basePlan = {
    video: {
      mode: 'transcode' as const,
      sourceCodec: 'h264',
      width: 1280,
      height: 720,
      fps: 30,
      filters: [] as string[],
      threads: 2,
      targetFps: 30,
      targetBitrateKbps: 2500,
      maxBitrateKbps: 3500,
    },
    audio: {
      mode: 'transcode' as const,
      sourceCodec: 'aac',
      sampleRate: 44100,
      channels: 2,
      targetCodec: 'opus' as const,
      targetBitrateKbps: 128 as const,
      targetSampleRate: 48_000 as const,
      targetChannels: 2 as const,
    },
    subtitle: null,
  };

  it('includes -extension_picky 0 for HLS URLs on FFmpeg >= 7', () => {
    const args = buildFfmpegNutArgs('http://example.com/stream.m3u8', basePlan, undefined, undefined, 7);
    const idx = args.indexOf('-extension_picky');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('0');
  });

  it('includes -extension_picky 0 for playlist URLs on FFmpeg >= 7', () => {
    const args = buildFfmpegNutArgs('https://cdn.example.com/playlist/123/load-playlist', basePlan, undefined, undefined, 7);
    expect(args).toContain('-extension_picky');
  });

  it('omits -extension_picky for HLS URLs on FFmpeg < 7', () => {
    const args = buildFfmpegNutArgs('http://example.com/stream.m3u8', basePlan, undefined, undefined, 5);
    expect(args).not.toContain('-extension_picky');
  });

  it('omits -extension_picky for HLS URLs when version unknown', () => {
    const args = buildFfmpegNutArgs('http://example.com/stream.m3u8', basePlan);
    expect(args).not.toContain('-extension_picky');
  });

  it('omits -extension_picky for direct MP4 URLs', () => {
    const args = buildFfmpegNutArgs('http://example.com/video.mp4', basePlan);
    expect(args).not.toContain('-extension_picky');
  });

  it('inserts httpHeaders before -i when provided', () => {
    const args = buildFfmpegNutArgs(
      'http://example.com/stream.m3u8',
      basePlan,
      undefined,
      { Referer: 'https://example.com/', Origin: 'https://example.com' }
    );

    const headersIdx = args.indexOf('-headers');
    const inputIdx = args.indexOf('-i');
    expect(headersIdx).toBeGreaterThan(-1);
    expect(headersIdx).toBeLessThan(inputIdx);
    expect(args[headersIdx + 1]).toContain('Referer: https://example.com/');
    expect(args[headersIdx + 1]).toContain('Origin: https://example.com');
  });

  it('does not add -headers when httpHeaders is undefined', () => {
    const args = buildFfmpegNutArgs('http://example.com/stream.m3u8', basePlan);
    expect(args).not.toContain('-headers');
  });

  it('does not add -headers when httpHeaders is empty', () => {
    const args = buildFfmpegNutArgs(
      'http://example.com/stream.m3u8',
      basePlan,
      undefined,
      {}
    );
    expect(args).not.toContain('-headers');
  });
});

describe('resolveLiveQuery', () => {
  it('rejects empty query', async () => {
    const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => logger } as any;
    await expect(
      Effect.runPromise(resolveLiveQuery('', logger))
    ).rejects.toThrow(/empty/i);
  });

  it('rejects whitespace-only query', async () => {
    const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => logger } as any;
    await expect(
      Effect.runPromise(resolveLiveQuery('   ', logger))
    ).rejects.toThrow(/empty/i);
  });
});
