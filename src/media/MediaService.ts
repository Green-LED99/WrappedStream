import { Context, Effect, Layer } from 'effect';
import { MediaError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';
import type { WebRtcConnection } from '../transport/WebRtcConnection.js';
import type { BaseMediaConnection } from '../discord/voice/VoiceGateway.js';
import { probeMedia, type FfprobeResult } from './Probe.js';
import {
  selectTranscodePlan,
  type TranscodePlan,
} from './TranscodePlan.js';
import {
  createFfmpegNutProcess,
  type FfmpegNutProcess,
} from './FFmpegPipeline.js';
import { demuxNutStream } from './Demuxer.js';
import { VideoStream } from './VideoStream.js';
import { AudioStream } from './AudioStream.js';

export class MediaService extends Context.Tag('MediaService')<
  MediaService,
  {
    readonly probe: (
      ffprobePath: string,
      url: string
    ) => Effect.Effect<FfprobeResult, MediaError>;
    readonly selectPlan: (
      probe: FfprobeResult
    ) => Effect.Effect<TranscodePlan, MediaError>;
    readonly createPipeline: (
      ffmpegPath: string,
      url: string,
      plan: TranscodePlan,
      audioUrl?: string,
      httpHeaders?: Record<string, string>
    ) => Effect.Effect<FfmpegNutProcess, MediaError>;
    readonly playStream: (
      input: NodeJS.ReadableStream,
      connection: BaseMediaConnection,
      webRtc: WebRtcConnection,
      logger: Logger,
      abortSignal?: AbortSignal
    ) => Effect.Effect<void, MediaError>;
  }
>() {}

export const MediaServiceLive = Layer.succeed(MediaService, {
  probe: (ffprobePath: string, url: string) =>
    Effect.tryPromise({
      try: () => probeMedia(ffprobePath, url),
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  selectPlan: (probeResult: FfprobeResult) =>
    Effect.try({
      try: () => selectTranscodePlan(probeResult),
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  createPipeline: (ffmpegPath: string, url: string, plan: TranscodePlan, audioUrl?: string, httpHeaders?: Record<string, string>) =>
    Effect.try({
      try: () => createFfmpegNutProcess(ffmpegPath, url, plan, audioUrl, httpHeaders),
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
    abortSignal?: AbortSignal
  ) =>
    Effect.tryPromise({
      try: async () => {
        const { video, audio } = await demuxNutStream(
          input,
          logger.child('demux')
        );

        connection.setSpeaking(true);
        connection.setVideoAttributes(true, {
          width: video.width,
          height: video.height,
          fps: Math.round(video.framerateNum / video.framerateDen),
        });

        const videoStream = new VideoStream(webRtc);
        const audioStream = audio ? new AudioStream(webRtc) : undefined;

        if (audio && audioStream) {
          videoStream.syncStream = audioStream;
          audioStream.syncStream = undefined;
          audio.stream.pipe(audioStream);
        }

        video.stream.pipe(videoStream);

        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            connection.setSpeaking(false);
            connection.setVideoAttributes(false);
          };

          const onSourceError = (error: Error) => {
            cleanup();
            abortSignal?.removeEventListener('abort', onAbort);
            video.stream.off('error', onSourceError);
            audio?.stream.off('error', onSourceError);
            reject(error);
          };

          const onAbort = () => {
            cleanup();
            video.stream.off('error', onSourceError);
            audio?.stream.off('error', onSourceError);
            reject(abortSignal?.reason ?? new Error('Aborted'));
          };

          abortSignal?.addEventListener('abort', onAbort, { once: true });
          video.stream.once('error', onSourceError);
          audio?.stream.once('error', onSourceError);

          videoStream.once('finish', () => {
            cleanup();
            abortSignal?.removeEventListener('abort', onAbort);
            video.stream.off('error', onSourceError);
            audio?.stream.off('error', onSourceError);
            resolve();
          });

          videoStream.once('error', (error) => {
            cleanup();
            abortSignal?.removeEventListener('abort', onAbort);
            video.stream.off('error', onSourceError);
            audio?.stream.off('error', onSourceError);
            reject(error);
          });
        });
      },
      catch: (error) =>
        new MediaError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});
