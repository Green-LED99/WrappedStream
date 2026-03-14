import { Context, Effect, Layer } from 'effect';
import { VoiceGatewayError } from '../../errors/index.js';
import type { WebRtcConnection, WebRtcParameters } from '../../transport/WebRtcConnection.js';
import type { Logger } from '../../utils/logger.js';
import type { DaveModule, DaveTransientKeys } from '../dave/types.js';
import {
  BaseMediaConnection,
  StreamConnection,
  type VideoAttributes,
  VoiceConnection,
  type VoiceGatewayCallbacks,
} from './VoiceGateway.js';

export type VoiceConnectParams = {
  voiceServer: string;
  voiceToken: string;
  sessionId: string;
  guildId: string;
  channelId: string;
  userId: string;
  dave: DaveModule;
  transientKeys: DaveTransientKeys;
  logger: Logger;
};

export type StreamConnectParams = VoiceConnectParams & {
  rtcServerId: string;
  rtcChannelId: string;
  streamKey: string;
};

export class VoiceService extends Context.Tag('VoiceService')<
  VoiceService,
  {
    readonly connectVoice: (
      params: VoiceConnectParams
    ) => Effect.Effect<VoiceConnection, VoiceGatewayError>;
    readonly connectStream: (
      params: StreamConnectParams
    ) => Effect.Effect<StreamConnection, VoiceGatewayError>;
    readonly waitUntilReady: (
      connection: BaseMediaConnection,
      timeoutMs?: number
    ) => Effect.Effect<WebRtcConnection, VoiceGatewayError>;
    readonly setPacketizer: (
      connection: BaseMediaConnection,
      params: WebRtcParameters
    ) => Effect.Effect<void, VoiceGatewayError>;
    readonly setSpeaking: (
      connection: BaseMediaConnection,
      speaking: boolean
    ) => Effect.Effect<void>;
    readonly setVideoAttributes: (
      connection: BaseMediaConnection,
      attrs: VideoAttributes | false
    ) => Effect.Effect<void>;
    readonly stop: (connection: BaseMediaConnection) => Effect.Effect<void>;
  }
>() {}

export const VoiceServiceLive = Layer.succeed(VoiceService, {
  connectVoice: (params: VoiceConnectParams) =>
    Effect.try({
      try: () => {
        const callbacks: VoiceGatewayCallbacks = {
          handleConnectionRecoveryRequested: (_conn, diag) => {
            params.logger.warn('Voice connection recovery requested', diag);
          },
          handleConnectionFatal: (_conn, error) => {
            params.logger.error('Voice connection fatal', { message: error.message });
          },
        };

        const connection = new VoiceConnection(
          callbacks,
          params.dave,
          params.logger.child('voice'),
          params.guildId,
          params.userId,
          params.channelId,
          params.transientKeys
        );

        connection.setSession(params.sessionId);
        connection.setTokens(params.voiceServer, params.voiceToken);
        return connection;
      },
      catch: (error) =>
        new VoiceGatewayError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  connectStream: (params: StreamConnectParams) =>
    Effect.try({
      try: () => {
        const callbacks: VoiceGatewayCallbacks = {
          handleConnectionRecoveryRequested: (_conn, diag) => {
            params.logger.warn('Stream connection recovery requested', diag);
          },
          handleConnectionFatal: (_conn, error) => {
            params.logger.error('Stream connection fatal', { message: error.message });
          },
        };

        const connection = new StreamConnection(
          callbacks,
          params.dave,
          params.logger.child('stream'),
          params.guildId,
          params.userId,
          params.channelId,
          params.transientKeys
        );

        connection.setStreamContext(params.rtcServerId, params.rtcChannelId, params.streamKey);
        connection.setSession(params.sessionId);
        connection.setTokens(params.voiceServer, params.voiceToken);
        return connection;
      },
      catch: (error) =>
        new VoiceGatewayError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  waitUntilReady: (connection: BaseMediaConnection, timeoutMs?: number) =>
    Effect.tryPromise({
      try: () => connection.waitUntilReady(timeoutMs),
      catch: (error) =>
        new VoiceGatewayError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  setPacketizer: (connection: BaseMediaConnection, params: WebRtcParameters) =>
    Effect.tryPromise({
      try: () => connection.webRtcConn.setPacketizer('H264', params),
      catch: (error) =>
        new VoiceGatewayError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),

  setSpeaking: (connection: BaseMediaConnection, speaking: boolean) =>
    Effect.sync(() => connection.setSpeaking(speaking)),

  setVideoAttributes: (connection: BaseMediaConnection, attrs: VideoAttributes | false) =>
    Effect.sync(() => {
      if (attrs === false) {
        connection.setVideoAttributes(false);
      } else {
        connection.setVideoAttributes(true, attrs);
      }
    }),

  stop: (connection: BaseMediaConnection) => Effect.sync(() => connection.stop()),
});
