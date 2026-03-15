import { Context, Effect, Layer } from 'effect';
import { GatewayError, VoiceGatewayError } from '../../errors/index.js';
import type { DaveModule } from '../dave/types.js';
import type { GatewayClient } from '../gateway/GatewayClient.js';
import type { WebRtcConnection } from '../../transport/WebRtcConnection.js';
import type { Logger } from '../../utils/logger.js';
import { Streamer } from './Streamer.js';

export class StreamerService extends Context.Tag('StreamerService')<
  StreamerService,
  {
    readonly create: (
      session: GatewayClient,
      dave: DaveModule,
      logger: Logger
    ) => Effect.Effect<Streamer>;
    readonly joinVoice: (
      streamer: Streamer,
      guildId: string,
      channelId: string
    ) => Effect.Effect<WebRtcConnection, GatewayError>;
    readonly createStream: (
      streamer: Streamer
    ) => Effect.Effect<WebRtcConnection, VoiceGatewayError>;
    readonly stopStream: (streamer: Streamer) => Effect.Effect<void>;
    readonly leaveVoice: (streamer: Streamer) => Effect.Effect<void>;
    readonly destroy: (streamer: Streamer) => Effect.Effect<void>;
  }
>() {}

export const StreamerServiceLive = Layer.succeed(StreamerService, {
  create: (session: GatewayClient, dave: DaveModule, logger: Logger) =>
    Effect.sync(() => new Streamer(session, dave, logger.child('streamer'))),

  joinVoice: (streamer: Streamer, guildId: string, channelId: string) =>
    Effect.tryPromise({
      try: () => streamer.joinVoice(guildId, channelId),
      catch: (error) =>
        new GatewayError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  createStream: (streamer: Streamer) =>
    Effect.tryPromise({
      try: () => streamer.createStream(),
      catch: (error) =>
        new VoiceGatewayError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  stopStream: (streamer: Streamer) =>
    Effect.sync(() => streamer.stopStream()),

  leaveVoice: (streamer: Streamer) =>
    Effect.sync(() => streamer.leaveVoice()),

  destroy: (streamer: Streamer) => Effect.sync(() => streamer.destroy()),
});
