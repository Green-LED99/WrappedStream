import { describe, expect, it } from 'vitest';
import {
  addonBaseFromManifest,
  buildStreamUrl,
  parseQuality,
} from '../src/stremio/TorrentioClient.js';
import type { TorrentioStream } from '../src/stremio/types.js';

describe('addonBaseFromManifest', () => {
  it('strips /manifest.json from a full Torrentio addon URL', () => {
    const manifest =
      'https://torrentio.strem.fun/qualityfilter=unknown|realdebrid=KEY/manifest.json';
    expect(addonBaseFromManifest(manifest)).toBe(
      'https://torrentio.strem.fun/qualityfilter=unknown|realdebrid=KEY'
    );
  });

  it('handles URL without trailing manifest.json gracefully', () => {
    const url = 'https://torrentio.strem.fun/config';
    expect(addonBaseFromManifest(url)).toBe(url);
  });

  it('strips trailing slashes', () => {
    const manifest =
      'https://torrentio.strem.fun/config/manifest.json';
    expect(addonBaseFromManifest(manifest)).toBe(
      'https://torrentio.strem.fun/config'
    );
  });

  it('is case-insensitive for manifest.json', () => {
    const manifest =
      'https://torrentio.strem.fun/config/MANIFEST.JSON';
    expect(addonBaseFromManifest(manifest)).toBe(
      'https://torrentio.strem.fun/config'
    );
  });
});

describe('buildStreamUrl', () => {
  const base = 'https://torrentio.strem.fun/config';

  it('builds a movie stream URL', () => {
    expect(buildStreamUrl(base, 'movie', 'tt0468569')).toBe(
      'https://torrentio.strem.fun/config/stream/movie/tt0468569.json'
    );
  });

  it('builds a series stream URL with season and episode', () => {
    expect(buildStreamUrl(base, 'series', 'tt0903747', 1, 1)).toBe(
      'https://torrentio.strem.fun/config/stream/series/tt0903747:1:1.json'
    );
  });

  it('builds a series stream URL without season/episode (meta-level)', () => {
    expect(buildStreamUrl(base, 'series', 'tt0903747')).toBe(
      'https://torrentio.strem.fun/config/stream/series/tt0903747.json'
    );
  });

  it('handles higher season/episode numbers', () => {
    expect(buildStreamUrl(base, 'series', 'tt0903747', 5, 16)).toBe(
      'https://torrentio.strem.fun/config/stream/series/tt0903747:5:16.json'
    );
  });
});

describe('parseQuality', () => {
  it('extracts quality from typical Torrentio name', () => {
    const stream: TorrentioStream = {
      name: '[RD+] Torrentio\n1080p',
      title: 'Some.Movie.1080p.BluRay.mkv',
      url: 'https://example.com/stream',
    };
    expect(parseQuality(stream)).toBe('1080p');
  });

  it('extracts quality from single-line name', () => {
    const stream: TorrentioStream = {
      name: '720p',
      title: 'Some.Movie.720p.mkv',
      url: 'https://example.com/stream',
    };
    expect(parseQuality(stream)).toBe('720p');
  });

  it('handles HDR quality tag', () => {
    const stream: TorrentioStream = {
      name: '[RD+] Torrentio\nHDR',
      title: 'Some.Movie.HDR.mkv',
      url: 'https://example.com/stream',
    };
    expect(parseQuality(stream)).toBe('HDR');
  });

  it('handles download variant', () => {
    const stream: TorrentioStream = {
      name: '[RD download] Torrentio\n720p',
      title: 'Some.Movie.720p.mkv',
      url: 'https://example.com/stream',
    };
    expect(parseQuality(stream)).toBe('720p');
  });

  it('returns unknown for empty name', () => {
    const stream: TorrentioStream = {
      name: '',
      title: 'Some.Movie.mkv',
      url: 'https://example.com/stream',
    };
    expect(parseQuality(stream)).toBe('unknown');
  });
});
