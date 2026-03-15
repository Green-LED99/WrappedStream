import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { parseYtdlpOutput } from '../src/youtube/YtdlpClient.js';
import { resolveYouTubeQuery } from '../src/youtube/YouTubeResolver.js';
import { createLogger } from '../src/utils/logger.js';

describe('parseYtdlpOutput', () => {
  it('parses valid yt-dlp JSON into ResolvedYouTubeVideo', () => {
    const json = JSON.stringify({
      id: 'dQw4w9WgXcQ',
      title: 'Rick Astley - Never Gonna Give You Up',
      webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      duration: 213,
      url: 'https://rr1.googlevideo.com/videoplayback?expire=1234',
      channel: 'Rick Astley',
    });

    const result = parseYtdlpOutput(json);
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.title).toBe('Rick Astley - Never Gonna Give You Up');
    expect(result.streamUrl).toContain('googlevideo.com');
    expect(result.durationSeconds).toBe(213);
    expect(result.channel).toBe('Rick Astley');
    expect(result.webpageUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('uses uploader as fallback when channel is missing', () => {
    const json = JSON.stringify({
      id: 'xyz123',
      title: 'Test Video',
      webpage_url: 'https://www.youtube.com/watch?v=xyz123',
      duration: 30,
      url: 'https://example.com/stream',
      uploader: 'Some Uploader',
    });

    const result = parseYtdlpOutput(json);
    expect(result.channel).toBe('Some Uploader');
  });

  it('sets channel to undefined when both channel and uploader are missing', () => {
    const json = JSON.stringify({
      id: 'abc',
      title: 'No Channel Video',
      webpage_url: 'https://www.youtube.com/watch?v=abc',
      duration: 60,
      url: 'https://example.com/stream',
    });

    const result = parseYtdlpOutput(json);
    expect(result.channel).toBeUndefined();
  });

  it('parses split video+audio requested_formats', () => {
    const json = JSON.stringify({
      id: 'split123',
      title: 'Split Format Video',
      webpage_url: 'https://www.youtube.com/watch?v=split123',
      duration: 120,
      url: null,
      channel: 'Test Channel',
      requested_formats: [
        {
          url: 'https://rr1.googlevideo.com/videoplayback?itag=137',
          vcodec: 'avc1.640028',
          acodec: 'none',
          format_id: '137',
          protocol: 'https',
        },
        {
          url: 'https://rr1.googlevideo.com/videoplayback?itag=140',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          format_id: '140',
          protocol: 'https',
        },
      ],
    });

    const result = parseYtdlpOutput(json);
    expect(result.videoId).toBe('split123');
    expect(result.streamUrl).toContain('itag=137');
    expect(result.audioUrl).toContain('itag=140');
    expect(result.channel).toBe('Test Channel');
  });

  it('throws when split formats have no video URL', () => {
    const json = JSON.stringify({
      id: 'abc',
      title: 'Test',
      webpage_url: 'https://youtube.com/watch?v=abc',
      duration: 60,
      url: null,
      requested_formats: [
        {
          url: 'https://example.com/audio',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
        },
        {
          url: 'https://example.com/audio2',
          vcodec: 'none',
          acodec: 'opus',
        },
      ],
    });

    expect(() => parseYtdlpOutput(json)).toThrow(/no video URL/i);
  });

  it('throws when url field is missing and no requested_formats', () => {
    const json = JSON.stringify({
      id: 'abc',
      title: 'Test',
      webpage_url: 'https://youtube.com/watch?v=abc',
      duration: 60,
    });

    expect(() => parseYtdlpOutput(json)).toThrow(/no stream URL/i);
  });

  it('throws when url field is empty string and no requested_formats', () => {
    const json = JSON.stringify({
      id: 'abc',
      title: 'Test',
      webpage_url: 'https://youtube.com/watch?v=abc',
      duration: 60,
      url: '',
    });

    expect(() => parseYtdlpOutput(json)).toThrow(/no stream URL/i);
  });

  it('throws on empty input', () => {
    expect(() => parseYtdlpOutput('')).toThrow(/empty output/i);
  });

  it('throws on whitespace-only input', () => {
    expect(() => parseYtdlpOutput('   \n  ')).toThrow(/empty output/i);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseYtdlpOutput('{not valid json')).toThrow();
  });
});

describe('resolveYouTubeQuery', () => {
  it('fails with YouTubeError for empty query', async () => {
    const logger = createLogger('error');
    await expect(
      Effect.runPromise(resolveYouTubeQuery('yt-dlp', '', logger))
    ).rejects.toThrow(/empty/i);
  });

  it('fails with YouTubeError for whitespace-only query', async () => {
    const logger = createLogger('error');
    await expect(
      Effect.runPromise(resolveYouTubeQuery('yt-dlp', '   ', logger))
    ).rejects.toThrow(/empty/i);
  });
});
