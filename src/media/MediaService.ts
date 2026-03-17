import { Context, Effect, Layer } from 'effect';
import { MediaError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';
import type { WebRtcConnection } from '../transport/WebRtcConnection.js';
import type { BaseMediaConnection } from '../discord/voice/VoiceGateway.js';
import { probeMedia, type FfprobeResult } from './Probe.js';
import {
  selectTranscodePlan,
  type TranscodePlan,
  type TranscodePlanOptions,
} from './TranscodePlan.js';
import {
  createFfmpegNutProcess,
  type FfmpegNutProcess,
} from './FFmpegPipeline.js';
import { demuxNutStream, type DemuxResult } from './Demuxer.js';
import { VideoStream } from './VideoStream.js';
import { AudioStream } from './AudioStream.js';
import type { ClockRef } from './BaseMediaStream.js';
import {
  detectEncoder,
  type EncoderCapabilities,
} from './EncoderDetect.js';

export class MediaService extends Context.Tag('MediaService')<
  MediaService,
  {
    readonly probe: (
      ffprobePath: string,
      url: string,
      httpHeaders?: Record<string, string>,
      ffmpegMajorVersion?: number
    ) => Effect.Effect<FfprobeResult, MediaError>;
    readonly selectPlan: (
      probe: FfprobeResult,
      options: TranscodePlanOptions
    ) => Effect.Effect<TranscodePlan, MediaError>;
    readonly detectEncoder: (
      ffmpegPath: string,
      preference: string
    ) => Effect.Effect<EncoderCapabilities, MediaError>;
    readonly createPipeline: (
      ffmpegPath: string,
      url: string,
      plan: TranscodePlan,
      audioUrl?: string,
      httpHeaders?: Record<string, string>,
      ffmpegMajorVersion?: number,
      seekSeconds?: number,
      audioStreamIndex?: number
    ) => Effect.Effect<FfmpegNutProcess, MediaError>;
    readonly playStream: (
      input: NodeJS.ReadableStream,
      connection: BaseMediaConnection,
      webRtc: WebRtcConnection,
      logger: Logger,
      abortSignal?: AbortSignal,
      maxBitrateKbps?: number
    ) => Effect.Effect<void, MediaError>;
  }
>() {}

export const MediaServiceLive = Layer.succeed(MediaService, {
  probe: (ffprobePath: string, url: string, httpHeaders?: Record<string, string>, ffmpegMajorVersion?: number) =>
    Effect.tryPromise({
      try: () => probeMedia(ffprobePath, url, httpHeaders, ffmpegMajorVersion),
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  selectPlan: (probeResult: FfprobeResult, options: TranscodePlanOptions) =>
    Effect.try({
      try: () => selectTranscodePlan(probeResult, options),
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  detectEncoder: (ffmpegPath: string, preference: string) =>
    Effect.tryPromise({
      try: () =>
        detectEncoder(
          ffmpegPath,
          preference as 'auto' | 'h264_nvmpi' | 'h264_v4l2m2m' | 'libx264'
        ),
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  createPipeline: (ffmpegPath: string, url: string, plan: TranscodePlan, audioUrl?: string, httpHeaders?: Record<string, string>, ffmpegMajorVersion?: number, seekSeconds?: number, audioStreamIndex?: number) =>
    Effect.try({
      try: () => createFfmpegNutProcess(ffmpegPath, url, plan, audioUrl, httpHeaders, ffmpegMajorVersion, seekSeconds, audioStreamIndex),
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  playStream: (
    input: NodeJS.ReadableStream,
    connection: BaseMediaConnection,
    webRtc: WebRtcConnection,
    logger: Logger,
    abortSignal?: AbortSignal,
    maxBitrateKbps?: number
  ) =>
    Effect.tryPromise({
      try: async () => {
        const { video, audio, done } = await demuxNutStream(
          input,
          logger.child('demux')
        );

        connection.setSpeaking(true);
        connection.setVideoAttributes(true, {
          width: video.width,
          height: video.height,
          fps: Math.round(video.framerateNum / video.framerateDen),
          ...(maxBitrateKbps != null ? { maxBitrateKbps } : {}),
        });

        const clockRef: ClockRef = {};
        const videoStream = new VideoStream(webRtc, clockRef);
        const audioStream = audio ? new AudioStream(webRtc, clockRef) : undefined;

        if (audio && audioStream) {
          videoStream.syncStream = audioStream;
          audioStream.syncStream = undefined;
          audio.stream.pipe(audioStream);
        }

        videoStream.on('stats', (stats) => {
          logger.debug('Video pipeline stats', stats);
        });

        video.stream.pipe(videoStream);

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = () => { if (settled) return false; settled = true; return true; };

          const cleanup = () => {
            connection.setSpeaking(false);
            connection.setVideoAttributes(false);
            // Destroy writable streams to stop frame processing.
            videoStream.destroy();
            audioStream?.destroy();
          };

          const destroySources = () => {
            // Destroy demuxer PassThrough pipes so the demuxer's background
            // packet loop unblocks and cleans up native handles.
            video.stream.destroy();
            audio?.stream.destroy();
          };

          const removeListeners = () => {
            abortSignal?.removeEventListener('abort', onAbort);
            video.stream.off('error', onSourceError);
            audio?.stream.off('error', onSourceError);
          };

          const onSourceError = (error: Error) => {
            if (!settle()) return;
            cleanup();
            destroySources();
            removeListeners();
            // Wait for the demuxer loop to fully finish before rejecting
            // so the next pipeline doesn't start while native handles are open.
            done.then(() => reject(error), () => reject(error));
          };

          const onAbort = () => {
            if (!settle()) return;
            cleanup();
            destroySources();
            removeListeners();
            const reason = abortSignal?.reason ?? new Error('Aborted');
            // Wait for the demuxer loop to fully finish before rejecting.
            done.then(() => reject(reason), () => reject(reason));
          };

          abortSignal?.addEventListener('abort', onAbort, { once: true });
          video.stream.once('error', onSourceError);
          audio?.stream.once('error', onSourceError);

          videoStream.once('finish', () => {
            if (!settle()) return;
            cleanup();
            // Destroy audio source pipe in case it's still draining.
            audio?.stream.destroy();
            removeListeners();
            // Wait for the demuxer loop to fully finish before resolving.
            done.then(() => resolve(), () => resolve());
          });

          videoStream.once('error', (error) => {
            if (!settle()) return;
            cleanup();
            destroySources();
            removeListeners();
            done.then(() => reject(error), () => reject(error));
          });
        });
      },
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});
