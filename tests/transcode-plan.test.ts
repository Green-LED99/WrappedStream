import { describe, expect, it } from 'vitest';
import {
  selectTranscodePlan,
  parseFrameRate,
  LOW_CPU_TARGET_HEIGHT,
  LOW_CPU_TARGET_FPS,
  LOW_CPU_AUDIO_SAMPLE_RATE,
  LOW_CPU_AUDIO_CHANNELS,
} from '../src/media/TranscodePlan.js';
import { findEnglishSubtitleIndex, type FfprobeResult, type FfprobeStream } from '../src/media/Probe.js';
import { buildFfmpegNutArgs } from '../src/media/FFmpegPipeline.js';

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

  it('detects English subtitle stream and includes in plan', () => {
    const probe: FfprobeResult = {
      streams: [
        { codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '24/1' },
        { codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', channels: 2 },
        { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'eng' } },
      ],
    };
    const plan = selectTranscodePlan(probe);
    expect(plan.subtitle).toBeDefined();
    expect(plan.subtitle?.streamIndex).toBe(0);
  });

  it('skips subtitle plan when no English subtitles present', () => {
    const probe: FfprobeResult = {
      streams: [
        { codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '24/1' },
        { codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', channels: 2 },
        { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'fre' } },
      ],
    };
    const plan = selectTranscodePlan(probe);
    expect(plan.subtitle).toBeUndefined();
  });

  it('picks correct subtitle index among multiple subtitle streams', () => {
    const probe: FfprobeResult = {
      streams: [
        { codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '24/1' },
        { codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', channels: 2 },
        { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'fre' } },
        { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'spa' } },
        { codec_name: 'ass', codec_type: 'subtitle', tags: { language: 'eng' } },
      ],
    };
    const plan = selectTranscodePlan(probe);
    expect(plan.subtitle).toBeDefined();
    expect(plan.subtitle?.streamIndex).toBe(2);
  });
});

describe('findEnglishSubtitleIndex', () => {
  it('returns undefined when no subtitle streams exist', () => {
    const streams: FfprobeStream[] = [
      { codec_name: 'h264', codec_type: 'video' },
      { codec_name: 'aac', codec_type: 'audio' },
    ];
    expect(findEnglishSubtitleIndex(streams)).toBeUndefined();
  });

  it('returns undefined for non-English subtitle streams', () => {
    const streams: FfprobeStream[] = [
      { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'fre' } },
      { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'ger' } },
    ];
    expect(findEnglishSubtitleIndex(streams)).toBeUndefined();
  });

  it('finds eng language subtitle', () => {
    const streams: FfprobeStream[] = [
      { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'eng' } },
    ];
    expect(findEnglishSubtitleIndex(streams)).toBe(0);
  });

  it('finds en language subtitle', () => {
    const streams: FfprobeStream[] = [
      { codec_name: 'ass', codec_type: 'subtitle', tags: { language: 'en' } },
    ];
    expect(findEnglishSubtitleIndex(streams)).toBe(0);
  });

  it('rejects bitmap subtitle codecs (dvd_subtitle)', () => {
    const streams: FfprobeStream[] = [
      { codec_name: 'dvd_subtitle', codec_type: 'subtitle', tags: { language: 'eng' } },
    ];
    expect(findEnglishSubtitleIndex(streams)).toBeUndefined();
  });

  it('rejects hdmv_pgs_subtitle (Blu-ray bitmap)', () => {
    const streams: FfprobeStream[] = [
      { codec_name: 'hdmv_pgs_subtitle', codec_type: 'subtitle', tags: { language: 'eng' } },
    ];
    expect(findEnglishSubtitleIndex(streams)).toBeUndefined();
  });

  it('accepts all text subtitle codecs', () => {
    const codecs = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'srt', 'text'];
    for (const codec of codecs) {
      const streams: FfprobeStream[] = [
        { codec_name: codec, codec_type: 'subtitle', tags: { language: 'eng' } },
      ];
      expect(findEnglishSubtitleIndex(streams)).toBe(0);
    }
  });

  it('returns index among subtitle streams only (not absolute stream index)', () => {
    const streams: FfprobeStream[] = [
      { codec_name: 'h264', codec_type: 'video' },
      { codec_name: 'aac', codec_type: 'audio' },
      { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'fre' } },
      { codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'eng' } },
    ];
    // eng is the second subtitle stream (index 1), not overall stream index 3
    expect(findEnglishSubtitleIndex(streams)).toBe(1);
  });
});

describe('buildFfmpegNutArgs', () => {
  const basePlan = {
    video: {
      mode: 'transcode' as const,
      sourceCodec: 'hevc',
      sourceHeight: 1080,
      sourceFps: 24,
      targetCodec: 'h264' as const,
      targetHeight: 720 as const,
      targetFps: 30 as const,
      targetBitrateKbps: 2500 as const,
      maxBitrateKbps: 4500 as const,
      threads: 2 as const,
      filters: ['scale=-2:720'],
    },
    audio: {
      mode: 'transcode' as const,
      sourceCodec: 'aac',
      sampleRate: 44100,
      channels: 6,
      targetCodec: 'opus' as const,
      targetBitrateKbps: 128 as const,
      targetSampleRate: 48000 as const,
      targetChannels: 2 as const,
    },
    usesTranscode: true,
  };

  it('does not add subtitle filter when no subtitle plan', () => {
    const args = buildFfmpegNutArgs('https://example.com/video.mkv', basePlan);
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toBe('scale=-2:720');
  });

  it('adds subtitle filter with escaped URL', () => {
    const plan = { ...basePlan, subtitle: { streamIndex: 0 } };
    const args = buildFfmpegNutArgs('https://example.com/video.mkv', plan);
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    const vf = args[vfIdx + 1]!;
    expect(vf).toContain('subtitles=');
    expect(vf).toContain(':si=0');
    // Colons in URL must be double-backslash escaped for FFmpeg filter parser
    expect(vf).toContain('https\\\\:');
  });

  it('escapes special characters in subtitle path', () => {
    const plan = { ...basePlan, subtitle: { streamIndex: 2 } };
    const url = "https://host:8080/path/file[v1]'s;name.mkv";
    const args = buildFfmpegNutArgs(url, plan);
    const vfIdx = args.indexOf('-vf');
    const vf = args[vfIdx + 1]!;
    // Colons double-backslash escaped
    expect(vf).toContain('https\\\\:');
    expect(vf).toContain('\\\\:8080');
    // Brackets escaped
    expect(vf).toContain('\\\\[v1\\\\]');
    // Quote escaped
    expect(vf).toContain("\\\\'s");
    // Semicolon escaped
    expect(vf).toContain('\\\\;name');
    // Stream index unescaped option
    expect(vf).toContain(':si=2');
  });

  it('produces correct filter chain order: scale, then subtitles', () => {
    const plan = { ...basePlan, subtitle: { streamIndex: 0 } };
    const args = buildFfmpegNutArgs('https://example.com/video.mkv', plan);
    const vfIdx = args.indexOf('-vf');
    const vf = args[vfIdx + 1]!;
    const scalePos = vf.indexOf('scale=');
    const subPos = vf.indexOf('subtitles=');
    expect(scalePos).toBeLessThan(subPos);
  });

  it('omits -vf when no filters and no subtitles', () => {
    const noFilterPlan = {
      ...basePlan,
      video: { ...basePlan.video, filters: [] },
    };
    const args = buildFfmpegNutArgs('https://example.com/video.mkv', noFilterPlan);
    expect(args.includes('-vf')).toBe(false);
  });

  it('adds second -i input and maps audio from input 1 when audioUrl is provided', () => {
    const videoUrl = 'https://rr1.googlevideo.com/videoplayback?itag=137';
    const audioUrl = 'https://rr1.googlevideo.com/videoplayback?itag=140';
    const args = buildFfmpegNutArgs(videoUrl, basePlan, audioUrl);

    // Should have two -i arguments
    const iIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === '-i') acc.push(i);
      return acc;
    }, []);
    expect(iIndices.length).toBe(2);
    expect(args[iIndices[0]! + 1]).toBe(videoUrl);
    expect(args[iIndices[1]! + 1]).toBe(audioUrl);

    // Audio should map from input 1, not input 0
    expect(args).toContain('1:a:0');
    expect(args).not.toContain('0:a:0?');
  });

  it('maps audio from input 0 when no audioUrl is provided', () => {
    const args = buildFfmpegNutArgs('https://example.com/video.mkv', basePlan);
    expect(args).toContain('0:a:0?');
    expect(args).not.toContain('1:a:0');
  });

  it('adds -headers flag before -i when httpHeaders are provided', () => {
    const headers = {
      Referer: 'https://cookiewebplay.xyz/',
      Origin: 'https://cookiewebplay.xyz',
    };
    const args = buildFfmpegNutArgs('https://example.com/stream.m3u8', basePlan, undefined, headers);

    const headersIdx = args.indexOf('-headers');
    expect(headersIdx).toBeGreaterThan(-1);

    // -headers value should contain the Referer and Origin
    const headersValue = args[headersIdx + 1]!;
    expect(headersValue).toContain('Referer: https://cookiewebplay.xyz/');
    expect(headersValue).toContain('Origin: https://cookiewebplay.xyz');

    // -headers must appear before the first -i
    const firstIIdx = args.indexOf('-i');
    expect(headersIdx).toBeLessThan(firstIIdx);
  });

  it('does not add -headers flag when httpHeaders is undefined', () => {
    const args = buildFfmpegNutArgs('https://example.com/video.mkv', basePlan);
    expect(args).not.toContain('-headers');
  });

  it('does not add -headers flag when httpHeaders is empty', () => {
    const args = buildFfmpegNutArgs('https://example.com/video.mkv', basePlan, undefined, {});
    expect(args).not.toContain('-headers');
  });
});
