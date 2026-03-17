import {
  findSubtitleIndex,
  findAudioStreamByLanguage,
  type FfprobeResult,
  type FfprobeStream,
} from './Probe.js';
import type { VideoEncoder } from './EncoderDetect.js';

// Default profile constants (current behaviour)
export const LOW_CPU_TARGET_HEIGHT = 720;
export const LOW_CPU_TARGET_FPS = 30;
export const LOW_CPU_VIDEO_TARGET_BITRATE_KBPS = 2500;
export const LOW_CPU_VIDEO_MAX_BITRATE_KBPS = 4500;
export const LOW_CPU_VIDEO_THREADS = 2;
export const LOW_CPU_AUDIO_BITRATE_KBPS = 128;
export const LOW_CPU_AUDIO_SAMPLE_RATE = 48_000;
export const LOW_CPU_AUDIO_CHANNELS = 2;

// Low-power profile constants (optimised for Jetson Nano / RPi class devices)
export const LOW_POWER_TARGET_FPS = 24;
export const LOW_POWER_VIDEO_TARGET_BITRATE_KBPS = 1800;
export const LOW_POWER_VIDEO_MAX_BITRATE_KBPS = 2500;
export const LOW_POWER_AUDIO_BITRATE_KBPS = 96;

// Ultra-low-power profile constants (for thermally throttled / multi-workload Jetson)
export const ULTRA_LOW_POWER_TARGET_HEIGHT = 480;
export const ULTRA_LOW_POWER_TARGET_FPS = 20;
export const ULTRA_LOW_POWER_VIDEO_TARGET_BITRATE_KBPS = 1200;
export const ULTRA_LOW_POWER_VIDEO_MAX_BITRATE_KBPS = 1500;
export const ULTRA_LOW_POWER_AUDIO_BITRATE_KBPS = 64;

export type VideoPlan =
  | {
      mode: 'copy';
      sourceCodec: string;
      sourceHeight: number;
      sourceFps: number;
    }
  | {
      mode: 'transcode';
      sourceCodec: string;
      sourceHeight: number;
      sourceFps: number;
      targetCodec: 'h264';
      encoder: VideoEncoder;
      preset?: string | undefined;
      targetHeight: number;
      targetFps: number;
      targetBitrateKbps: number;
      maxBitrateKbps: number;
      threads: number;
      filters: string[];
    };

export type AudioPlan =
  | {
      mode: 'copy';
      audioStreamIndex?: number;
      sourceCodec: string;
      sampleRate: number;
      channels: number;
    }
  | {
      mode: 'transcode';
      audioStreamIndex?: number;
      sourceCodec: string;
      sampleRate: number;
      channels: number;
      targetCodec: 'opus';
      targetBitrateKbps: number;
      targetSampleRate: typeof LOW_CPU_AUDIO_SAMPLE_RATE;
      targetChannels: typeof LOW_CPU_AUDIO_CHANNELS;
    };

export type SubtitlePlan = {
  /** Index of the subtitle stream among all subtitle streams (for FFmpeg `si=`). */
  streamIndex: number;
};

export type TranscodePlan = {
  video: VideoPlan;
  audio?: AudioPlan;
  subtitle?: SubtitlePlan;
  usesTranscode: boolean;
};

export interface TranscodePlanOptions {
  encoder: VideoEncoder;
  subtitleBurnIn: 'auto' | 'never';
  performanceProfile: 'default' | 'low-power' | 'ultra-low-power';
  language: string;
}

export function parseFrameRate(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? '1');

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

export function selectTranscodePlan(
  probe: FfprobeResult,
  options: TranscodePlanOptions
): TranscodePlan {
  const videoStream = selectStream(probe.streams, 'video');
  const audioStream =
    findAudioStreamByLanguage(probe.streams, options.language) ??
    probe.streams.find((item) => item.codec_type === 'audio');

  const videoSourceCodec = normalizeCodec(videoStream.codec_name);
  const videoSourceHeight = videoStream.height ?? 0;
  const videoSourceFps = parseFrameRate(videoStream.avg_frame_rate);

  const isLowPower = options.performanceProfile === 'low-power';
  const isUltraLowPower = options.performanceProfile === 'ultra-low-power';
  const targetHeight = isUltraLowPower
    ? ULTRA_LOW_POWER_TARGET_HEIGHT
    : LOW_CPU_TARGET_HEIGHT;
  const targetFps = isUltraLowPower
    ? ULTRA_LOW_POWER_TARGET_FPS
    : isLowPower
      ? LOW_POWER_TARGET_FPS
      : LOW_CPU_TARGET_FPS;
  const targetBitrate = isUltraLowPower
    ? ULTRA_LOW_POWER_VIDEO_TARGET_BITRATE_KBPS
    : isLowPower
      ? LOW_POWER_VIDEO_TARGET_BITRATE_KBPS
      : LOW_CPU_VIDEO_TARGET_BITRATE_KBPS;
  const maxBitrate = isUltraLowPower
    ? ULTRA_LOW_POWER_VIDEO_MAX_BITRATE_KBPS
    : isLowPower
      ? LOW_POWER_VIDEO_MAX_BITRATE_KBPS
      : LOW_CPU_VIDEO_MAX_BITRATE_KBPS;

  // Detect subtitles (unless disabled).
  const subIndex =
    options.subtitleBurnIn === 'never'
      ? undefined
      : findSubtitleIndex(probe.streams, options.language);
  const subtitle: SubtitlePlan | undefined =
    subIndex != null ? { streamIndex: subIndex } : undefined;

  const needsSubtitleBurnIn = subtitle != null;

  // H.264 profiles that guarantee no B-frames by definition.
  const videoProfile = videoStream.profile?.toLowerCase() ?? '';
  const isGuaranteedBFrameFree =
    videoProfile === 'baseline' ||
    videoProfile === 'constrained baseline' ||
    videoProfile === '66'; // ffprobe numeric profile_idc for Baseline

  // Main and High profiles CAN use B-frames, but many streaming sources
  // (YouTube, HLS CDNs) use these profiles without B-frames.  The
  // `has_b_frames` field from ffprobe tells us the actual state.  When
  // it reports 0, the source is safe for copy-mode RTP packetization.
  const hasBFrames = videoStream.has_b_frames ?? -1;
  const isBFrameFreeByProbe = hasBFrames === 0;

  const isBFrameFreeProfile = isGuaranteedBFrameFree || isBFrameFreeByProbe;

  // Video copy eligibility: source is H.264 without B-frames, at or below
  // target resolution and frame rate, with no subtitle burn-in required.
  const canCopyVideo =
    videoSourceCodec === 'h264' &&
    isBFrameFreeProfile &&
    videoSourceHeight > 0 &&
    videoSourceHeight <= targetHeight &&
    videoSourceFps > 0 &&
    videoSourceFps <= targetFps &&
    !needsSubtitleBurnIn;

  let video: VideoPlan;

  if (canCopyVideo) {
    video = {
      mode: 'copy',
      sourceCodec: videoSourceCodec,
      sourceHeight: videoSourceHeight,
      sourceFps: videoSourceFps,
    };
  } else {
    const videoFilters: string[] = [];
    if (videoSourceHeight > targetHeight || videoSourceHeight === 0) {
      videoFilters.push(`scale=-2:${targetHeight}`);
    }
    if (videoSourceFps === 0 || videoSourceFps > targetFps) {
      videoFilters.push(`fps=${targetFps}`);
    }

    const preset =
      options.encoder === 'libx264'
        ? isUltraLowPower
          ? 'ultrafast'
          : isLowPower
            ? 'ultrafast'
            : 'fast'
        : undefined;

    // When a hardware encoder is handling video, the CPU is free for
    // filter processing (scaling, subtitle burn-in) so we can afford
    // more filter threads.  Software encoding should use all four
    // Cortex-A57 cores on Jetson Nano for maximum throughput.
    const isHwEncoder =
      options.encoder === 'h264_nvmpi' || options.encoder === 'h264_v4l2m2m';
    const threads = isHwEncoder ? 3 : 4;

    video = {
      mode: 'transcode',
      sourceCodec: videoSourceCodec,
      sourceHeight: videoSourceHeight,
      sourceFps: videoSourceFps,
      targetCodec: 'h264',
      encoder: options.encoder,
      preset,
      targetHeight,
      targetFps,
      targetBitrateKbps: targetBitrate,
      maxBitrateKbps: maxBitrate,
      threads,
      filters: videoFilters,
    };
  }

  const audio = audioStream ? selectAudioPlan(audioStream, isLowPower, isUltraLowPower) : undefined;

  return {
    video,
    ...(audio ? { audio } : {}),
    ...(subtitle ? { subtitle } : {}),
    usesTranscode: video.mode === 'transcode' || audio?.mode === 'transcode',
  };
}

export function describeTranscodePlan(plan: TranscodePlan): Record<string, unknown> {
  const videoDesc: Record<string, unknown> =
    plan.video.mode === 'copy'
      ? {
          mode: 'copy',
          sourceCodec: plan.video.sourceCodec,
          sourceHeight: plan.video.sourceHeight,
          sourceFps: plan.video.sourceFps,
        }
      : {
          mode: 'transcode',
          sourceCodec: plan.video.sourceCodec,
          sourceHeight: plan.video.sourceHeight,
          sourceFps: plan.video.sourceFps,
          targetCodec: plan.video.targetCodec,
          encoder: plan.video.encoder,
          preset: plan.video.preset ?? null,
          targetHeight: plan.video.targetHeight,
          targetFps: plan.video.targetFps,
          targetBitrateKbps: plan.video.targetBitrateKbps,
          maxBitrateKbps: plan.video.maxBitrateKbps,
          threads: plan.video.threads,
          filters: plan.video.filters,
        };

  return {
    usesTranscode: plan.usesTranscode,
    video: videoDesc,
    audio: plan.audio
      ? {
          mode: plan.audio.mode,
          sourceCodec: plan.audio.sourceCodec,
          sampleRate: plan.audio.sampleRate,
          channels: plan.audio.channels,
          ...(plan.audio.mode === 'transcode'
            ? {
                targetCodec: plan.audio.targetCodec,
                targetBitrateKbps: plan.audio.targetBitrateKbps,
                targetSampleRate: plan.audio.targetSampleRate,
                targetChannels: plan.audio.targetChannels,
              }
            : {}),
        }
      : null,
    subtitle: plan.subtitle
      ? { streamIndex: plan.subtitle.streamIndex, burnIn: true }
      : null,
  };
}

function selectAudioPlan(stream: FfprobeStream, isLowPower: boolean, isUltraLowPower: boolean): AudioPlan {
  const sourceCodec = normalizeCodec(stream.codec_name);
  const sampleRate = Number(stream.sample_rate ?? '0');
  const channels = stream.channels ?? 0;
  const canCopy =
    sourceCodec === 'opus' &&
    sampleRate === LOW_CPU_AUDIO_SAMPLE_RATE &&
    channels > 0 &&
    channels <= LOW_CPU_AUDIO_CHANNELS;

  const indexPart = stream.index != null ? { audioStreamIndex: stream.index } : {};

  // Ultra-low-power uses 64 kbps, low-power uses 96 kbps, default uses 128 kbps.
  const audioBitrate = isUltraLowPower
    ? ULTRA_LOW_POWER_AUDIO_BITRATE_KBPS
    : isLowPower
      ? LOW_POWER_AUDIO_BITRATE_KBPS
      : LOW_CPU_AUDIO_BITRATE_KBPS;

  return canCopy
    ? {
        mode: 'copy',
        ...indexPart,
        sourceCodec,
        sampleRate,
        channels,
      }
    : {
        mode: 'transcode',
        ...indexPart,
        sourceCodec,
        sampleRate,
        channels,
        targetCodec: 'opus',
        targetBitrateKbps: audioBitrate,
        targetSampleRate: LOW_CPU_AUDIO_SAMPLE_RATE,
        targetChannels: LOW_CPU_AUDIO_CHANNELS,
      };
}

function selectStream(streams: FfprobeStream[], codecType: string): FfprobeStream {
  const stream = streams.find((item) => item.codec_type === codecType);

  if (!stream) {
    throw new Error(`Expected ${codecType} stream metadata to be available.`);
  }

  return stream;
}

function normalizeCodec(codecName: string | undefined): string {
  return codecName?.toLowerCase() ?? 'unknown';
}
