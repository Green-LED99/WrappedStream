import { describe, expect, it } from 'vitest';
import {
  selectTranscodePlan,
  parseFrameRate,
  LOW_CPU_TARGET_HEIGHT,
  LOW_CPU_TARGET_FPS,
  LOW_CPU_AUDIO_SAMPLE_RATE,
  LOW_CPU_AUDIO_CHANNELS,
} from '../src/media/TranscodePlan.js';
import type { FfprobeResult } from '../src/media/Probe.js';

describe('parseFrameRate', () => {
  it('parses standard fraction format', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('24/1')).toBe(24);
    expect(parseFrameRate('60000/1001')).toBeCloseTo(59.94, 1);
  });

  it('handles single integer', () => {
    expect(parseFrameRate('25')).toBe(25);
  });

  it('returns 0 for undefined', () => {
    expect(parseFrameRate(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseFrameRate('')).toBe(0);
  });

  it('returns 0 for invalid values', () => {
    expect(parseFrameRate('abc/def')).toBe(0);
    expect(parseFrameRate('0/0')).toBe(0);
  });
});

describe('selectTranscodePlan', () => {
  function makeProbe(overrides?: {
    videoCodec?: string;
    videoWidth?: number;
    videoHeight?: number;
    videoFps?: string;
    audioCodec?: string;
    audioSampleRate?: string;
    audioChannels?: number;
    hasAudio?: boolean;
  }): FfprobeResult {
    const streams = [
      {
        codec_name: overrides?.videoCodec ?? 'h264',
        codec_type: 'video',
        width: overrides?.videoWidth ?? 1920,
        height: overrides?.videoHeight ?? 1080,
        avg_frame_rate: overrides?.videoFps ?? '30/1',
      },
    ];

    if (overrides?.hasAudio !== false) {
      streams.push({
        codec_name: overrides?.audioCodec ?? 'aac',
        codec_type: 'audio',
        width: undefined as unknown as number,
        height: undefined as unknown as number,
        avg_frame_rate: undefined,
        ...{
          sample_rate: overrides?.audioSampleRate ?? '44100',
          channels: overrides?.audioChannels ?? 2,
        },
      });
    }

    return { streams };
  }

  it('selects transcode for 1080p H264 source', () => {
    const plan = selectTranscodePlan(makeProbe());
    expect(plan.video.mode).toBe('transcode');
    expect(plan.usesTranscode).toBe(true);
  });

  it('always transcodes even for 720p H264 at 24fps', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        videoCodec: 'h264',
        videoHeight: 720,
        videoFps: '24/1',
        audioCodec: 'opus',
        audioSampleRate: '48000',
        audioChannels: 2,
      })
    );
    expect(plan.video.mode).toBe('transcode');
  });

  it('always transcodes VP9 source', () => {
    const plan = selectTranscodePlan(
      makeProbe({ videoCodec: 'vp9', videoHeight: 480, videoFps: '24/1' })
    );
    expect(plan.video.mode).toBe('transcode');
  });

  it('always transcodes 480p H264 (under target)', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        videoCodec: 'h264',
        videoHeight: 480,
        videoFps: '24/1',
      })
    );
    expect(plan.video.mode).toBe('transcode');
  });

  it('selects transcode for H264 over target fps', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        videoCodec: 'h264',
        videoHeight: 720,
        videoFps: '60/1',
      })
    );
    expect(plan.video.mode).toBe('transcode');
    if (plan.video.mode === 'transcode') {
      expect(plan.video.targetFps).toBe(LOW_CPU_TARGET_FPS);
    }
  });

  it('selects audio transcode for AAC source', () => {
    const plan = selectTranscodePlan(makeProbe({ audioCodec: 'aac' }));
    expect(plan.audio?.mode).toBe('transcode');
    if (plan.audio?.mode === 'transcode') {
      expect(plan.audio.targetSampleRate).toBe(LOW_CPU_AUDIO_SAMPLE_RATE);
      expect(plan.audio.targetChannels).toBe(LOW_CPU_AUDIO_CHANNELS);
    }
  });

  it('selects audio copy for Opus 48kHz 2ch', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        audioCodec: 'opus',
        audioSampleRate: '48000',
        audioChannels: 2,
      })
    );
    expect(plan.audio?.mode).toBe('copy');
  });

  it('selects audio transcode for Opus with wrong sample rate', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        audioCodec: 'opus',
        audioSampleRate: '44100',
        audioChannels: 2,
      })
    );
    expect(plan.audio?.mode).toBe('transcode');
  });

  it('handles video-only source (no audio)', () => {
    const plan = selectTranscodePlan(makeProbe({ hasAudio: false }));
    expect(plan.audio).toBeUndefined();
  });

  it('adds scale filter when height exceeds target', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        videoCodec: 'vp9',
        videoHeight: 1080,
        videoFps: '24/1',
      })
    );
    if (plan.video.mode === 'transcode') {
      expect(plan.video.filters).toContain(
        `scale=-2:${LOW_CPU_TARGET_HEIGHT}`
      );
    }
  });

  it('does not add scale filter when height is at or below target', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        videoCodec: 'h264',
        videoHeight: 480,
        videoFps: '24/1',
      })
    );
    if (plan.video.mode === 'transcode') {
      expect(plan.video.filters).not.toContain(
        `scale=-2:${LOW_CPU_TARGET_HEIGHT}`
      );
    }
  });

  it('adds fps filter when fps exceeds target', () => {
    const plan = selectTranscodePlan(
      makeProbe({
        videoCodec: 'vp9',
        videoHeight: 720,
        videoFps: '60/1',
      })
    );
    if (plan.video.mode === 'transcode') {
      expect(plan.video.filters).toContain(`fps=${LOW_CPU_TARGET_FPS}`);
    }
  });
});
