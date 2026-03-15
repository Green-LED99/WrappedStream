import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import { AppConfig } from '../src/config/schema.js';

const decode = Schema.decodeUnknown(AppConfig);

describe('AppConfig schema validation', () => {
  it('accepts valid config with all required fields', async () => {
    const raw = {
      token: 'test-token-123',
      guildId: '111222333444555',
      channelId: '666777888999000',
      videoUrl: 'https://example.com/video.mp4',
    };

    const result = await Effect.runPromise(decode(raw));
    expect(result.token).toBe('test-token-123');
    expect(result.guildId).toBe('111222333444555');
    expect(result.channelId).toBe('666777888999000');
    expect(result.videoUrl).toBe('https://example.com/video.mp4');
    expect(result.logLevel).toBe('info');
    expect(result.ffmpegPath).toBe('ffmpeg');
    expect(result.ffprobePath).toBe('ffprobe');
  });

  it('applies default values for optional fields', async () => {
    const raw = {
      token: 'tok',
      guildId: 'g',
      channelId: 'c',
      videoUrl: 'https://example.com/v.mp4',
    };

    const result = await Effect.runPromise(decode(raw));
    expect(result.logLevel).toBe('info');
    expect(result.ffmpegPath).toBe('ffmpeg');
    expect(result.ffprobePath).toBe('ffprobe');
  });

  it('accepts explicit log level values', async () => {
    const raw = {
      token: 'tok',
      guildId: 'g',
      channelId: 'c',
      videoUrl: 'https://example.com/v.mp4',
      logLevel: 'debug',
    };

    const result = await Effect.runPromise(decode(raw));
    expect(result.logLevel).toBe('debug');
  });

  it('accepts explicit ffmpeg paths', async () => {
    const raw = {
      token: 'tok',
      guildId: 'g',
      channelId: 'c',
      videoUrl: 'https://example.com/v.mp4',
      ffmpegPath: '/usr/local/bin/ffmpeg',
      ffprobePath: '/usr/local/bin/ffprobe',
    };

    const result = await Effect.runPromise(decode(raw));
    expect(result.ffmpegPath).toBe('/usr/local/bin/ffmpeg');
    expect(result.ffprobePath).toBe('/usr/local/bin/ffprobe');
  });

  it('rejects missing token', async () => {
    const raw = {
      guildId: 'g',
      channelId: 'c',
      videoUrl: 'https://example.com/v.mp4',
    };

    await expect(Effect.runPromise(decode(raw))).rejects.toThrow();
  });

  it('rejects missing guildId', async () => {
    const raw = {
      token: 'tok',
      channelId: 'c',
      videoUrl: 'https://example.com/v.mp4',
    };

    await expect(Effect.runPromise(decode(raw))).rejects.toThrow();
  });

  it('rejects missing channelId', async () => {
    const raw = {
      token: 'tok',
      guildId: 'g',
      videoUrl: 'https://example.com/v.mp4',
    };

    await expect(Effect.runPromise(decode(raw))).rejects.toThrow();
  });

  it('rejects missing videoUrl', async () => {
    const raw = {
      token: 'tok',
      guildId: 'g',
      channelId: 'c',
    };

    await expect(Effect.runPromise(decode(raw))).rejects.toThrow();
  });
});
