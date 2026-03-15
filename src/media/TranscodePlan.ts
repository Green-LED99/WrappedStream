import type { FfprobeResult, FfprobeStream } from './Probe.js';

export const LOW_CPU_TARGET_HEIGHT = 720;
export const LOW_CPU_TARGET_FPS = 30;
export const LOW_CPU_VIDEO_TARGET_BITRATE_KBPS = 2500;
export const LOW_CPU_VIDEO_MAX_BITRATE_KBPS = 4500;
export const LOW_CPU_VIDEO_THREADS = 2;
export const LOW_CPU_AUDIO_BITRATE_KBPS = 128;
export const LOW_CPU_AUDIO_SAMPLE_RATE = 48_000;
export const LOW_CPU_AUDIO_CHANNELS = 2;

export type VideoPlan = {
  mode: 'transcode';
  sourceCodec: string;
  sourceHeight: number;
  sourceFps: number;
  targetCodec: 'h264';
  targetHeight: typeof LOW_CPU_TARGET_HEIGHT;
  targetFps: typeof LOW_CPU_TARGET_FPS;
  targetBitrateKbps: typeof LOW_CPU_VIDEO_TARGET_BITRATE_KBPS;
  maxBitrateKbps: typeof LOW_CPU_VIDEO_MAX_BITRATE_KBPS;
  threads: typeof LOW_CPU_VIDEO_THREADS;
  filters: string[];
};

export type AudioPlan =
  | {
      mode: 'copy';
      sourceCodec: string;
      sampleRate: number;
      channels: number;
    }
  | {
      mode: 'transcode';
      sourceCodec: string;
      sampleRate: number;
      channels: number;
      targetCodec: 'opus';
      targetBitrateKbps: typeof LOW_CPU_AUDIO_BITRATE_KBPS;
      targetSampleRate: typeof LOW_CPU_AUDIO_SAMPLE_RATE;
      targetChannels: typeof LOW_CPU_AUDIO_CHANNELS;
    };

export type TranscodePlan = {
  video: VideoPlan;
  audio?: AudioPlan;
  usesTranscode: boolean;
};

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

export function selectTranscodePlan(probe: FfprobeResult): TranscodePlan {
  const videoStream = selectStream(probe.streams, 'video');
  const audioStream = probe.streams.find((item) => item.codec_type === 'audio');

  const videoSourceCodec = normalizeCodec(videoStream.codec_name);
  const videoSourceHeight = videoStream.height ?? 0;
  const videoSourceFps = parseFrameRate(videoStream.avg_frame_rate);

  // Always transcode video to enforce a hard 720p 30fps cap across the
  // board.  Even if the source is already H.264 at or below the target,
  // re-encoding guarantees consistent framing and bitrate control.
  const videoFilters: string[] = [];
  if (videoSourceHeight > LOW_CPU_TARGET_HEIGHT || videoSourceHeight === 0) {
    videoFilters.push(`scale=-2:${LOW_CPU_TARGET_HEIGHT}`);
  }

  if (videoSourceFps === 0 || videoSourceFps > LOW_CPU_TARGET_FPS) {
    videoFilters.push(`fps=${LOW_CPU_TARGET_FPS}`);
  }

  const video: VideoPlan = {
    mode: 'transcode',
    sourceCodec: videoSourceCodec,
    sourceHeight: videoSourceHeight,
    sourceFps: videoSourceFps,
    targetCodec: 'h264',
    targetHeight: LOW_CPU_TARGET_HEIGHT,
    targetFps: LOW_CPU_TARGET_FPS,
    targetBitrateKbps: LOW_CPU_VIDEO_TARGET_BITRATE_KBPS,
    maxBitrateKbps: LOW_CPU_VIDEO_MAX_BITRATE_KBPS,
    threads: LOW_CPU_VIDEO_THREADS,
    filters: videoFilters,
  };

  const audio = audioStream ? selectAudioPlan(audioStream) : undefined;

  return {
    video,
    ...(audio ? { audio } : {}),
    usesTranscode: video.mode === 'transcode' || audio?.mode === 'transcode',
  };
}

export function describeTranscodePlan(plan: TranscodePlan): Record<string, unknown> {
  return {
    usesTranscode: plan.usesTranscode,
    video: {
      mode: plan.video.mode,
      sourceCodec: plan.video.sourceCodec,
      sourceHeight: plan.video.sourceHeight,
      sourceFps: plan.video.sourceFps,
      targetCodec: plan.video.targetCodec,
      targetHeight: plan.video.targetHeight,
      targetFps: plan.video.targetFps,
      targetBitrateKbps: plan.video.targetBitrateKbps,
      maxBitrateKbps: plan.video.maxBitrateKbps,
      threads: plan.video.threads,
      filters: plan.video.filters,
    },
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
  };
}

function selectAudioPlan(stream: FfprobeStream): AudioPlan {
  const sourceCodec = normalizeCodec(stream.codec_name);
  const sampleRate = Number(stream.sample_rate ?? '0');
  const channels = stream.channels ?? 0;
  const canCopy =
    sourceCodec === 'opus' &&
    sampleRate === LOW_CPU_AUDIO_SAMPLE_RATE &&
    channels > 0 &&
    channels <= LOW_CPU_AUDIO_CHANNELS;

  return canCopy
    ? {
        mode: 'copy',
        sourceCodec,
        sampleRate,
        channels,
      }
    : {
        mode: 'transcode',
        sourceCodec,
        sampleRate,
        channels,
        targetCodec: 'opus',
        targetBitrateKbps: LOW_CPU_AUDIO_BITRATE_KBPS,
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
