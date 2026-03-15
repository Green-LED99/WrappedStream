import { setTimeout as sleep } from 'node:timers/promises';
import type {
  GatewayStreamCreate,
  GatewayStreamDelete,
  GatewayStreamServerUpdate,
} from '../gateway/events.js';
import { GatewayOpcode } from '../gateway/opcodes.js';
import type { GatewayClient } from '../gateway/GatewayClient.js';
import type { StreamConnection } from '../voice/VoiceGateway.js';
import type { WebRtcConnection } from '../../transport/WebRtcConnection.js';
import type { Logger } from '../../utils/logger.js';
import { generateStreamKey, parseStreamKey } from './utils.js';

const INITIAL_STREAM_ATTEMPTS = 3;
const HANDSHAKE_TIMEOUT_MS = 8_000;

type StreamHandshakeState = {
  state: string;
  streamKey: string | null;
  rtcServerId: string | null;
  rtcChannelId: string | null;
  endpoint: string | null;
  token: string | null;
  sawStreamCreate: boolean;
  sawStreamServer: boolean;
  sawNullEndpoint: boolean;
  deletedReason: string | null;
};

export class StreamJoinCoordinator {
  private handshake: StreamHandshakeState = {
    state: 'idle',
    streamKey: null,
    rtcServerId: null,
    rtcChannelId: null,
    endpoint: null,
    token: null,
    sawStreamCreate: false,
    sawStreamServer: false,
    sawNullEndpoint: false,
    deletedReason: null,
  };
  private pendingAttempt:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
      }
    | undefined;

  public constructor(
    private readonly session: GatewayClient,
    private readonly connection: StreamConnection,
    private readonly logger: Logger,
    private readonly guildId: string,
    private readonly channelId: string,
    private readonly userId: string,
    private readonly voiceSessionIdProvider: () => string | null
  ) {}

  public async connectInitial(): Promise<WebRtcConnection> {
    let lastError: Error | null = null;

    for (
      let attempt = 1;
      attempt <= INITIAL_STREAM_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.runAttempt(attempt);
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error('Stream create failed.');
        this.handshake.state = 'failed';
        this.logger.warn('Stream create attempt failed', {
          guildId: this.guildId,
          channelId: this.channelId,
          attempt,
          message: lastError.message,
        });
        // If stream was explicitly deleted (not unavailable), don't retry
        if (
          this.handshake.deletedReason &&
          this.handshake.deletedReason !== 'unavailable'
        ) {
          throw lastError;
        }
        if (attempt < INITIAL_STREAM_ATTEMPTS) {
          await sleep(backoffDelay(attempt));
        }
      }
    }

    throw lastError ?? new Error('Stream create failed.');
  }

  public async refresh(attempt: number): Promise<void> {
    await this.runAttempt(attempt);
  }

  public handleStreamCreate(payload: GatewayStreamCreate): void {
    const parsed = parseStreamKey(payload.d.stream_key);
    if (
      parsed.type !== 'guild' ||
      parsed.guildId !== this.guildId ||
      parsed.channelId !== this.channelId ||
      parsed.userId !== this.userId
    ) {
      return;
    }

    this.handshake.sawStreamCreate = true;
    this.handshake.streamKey = payload.d.stream_key;
    this.handshake.rtcServerId = payload.d.rtc_server_id;
    this.handshake.rtcChannelId = payload.d.rtc_channel_id;
    this.handshake.deletedReason = null;
    this.handshake.state = this.handshake.endpoint
      ? 'connecting_stream_ws'
      : 'awaiting_stream_server';
    this.logger.info('Stream create received', {
      guildId: this.guildId,
      channelId: this.channelId,
      streamKey: payload.d.stream_key,
      rtcServerId: payload.d.rtc_server_id,
      rtcChannelId: payload.d.rtc_channel_id,
    });
    this.maybeResolveAttempt();
  }

  public handleStreamServerUpdate(payload: GatewayStreamServerUpdate): void {
    const parsed = parseStreamKey(payload.d.stream_key);
    if (
      parsed.type !== 'guild' ||
      parsed.guildId !== this.guildId ||
      parsed.channelId !== this.channelId ||
      parsed.userId !== this.userId
    ) {
      return;
    }

    this.handshake.sawStreamServer = true;
    if (!payload.d.endpoint) {
      this.handshake.endpoint = null;
      this.handshake.token = null;
      this.handshake.sawNullEndpoint = true;
      this.logger.warn(
        'Stream server reallocated, waiting for a replacement endpoint',
        {
          guildId: this.guildId,
          channelId: this.channelId,
        }
      );
      return;
    }

    this.handshake.endpoint = payload.d.endpoint;
    this.handshake.token = payload.d.token;
    this.handshake.deletedReason = null;
    this.handshake.state = this.handshake.streamKey
      ? 'connecting_stream_ws'
      : 'awaiting_stream_create';
    this.logger.info('Stream server received', {
      guildId: this.guildId,
      channelId: this.channelId,
      endpoint: payload.d.endpoint,
    });
    this.maybeResolveAttempt();
  }

  public handleStreamDelete(payload: GatewayStreamDelete): void {
    const parsed = parseStreamKey(payload.d.stream_key);
    if (
      parsed.type !== 'guild' ||
      parsed.guildId !== this.guildId ||
      parsed.channelId !== this.channelId ||
      parsed.userId !== this.userId
    ) {
      return;
    }

    const reason = payload.d.unavailable
      ? 'unavailable'
      : (payload.d.reason ?? 'unknown');
    this.handshake.deletedReason = reason;
    this.handshake.state = 'failed';
    this.logger.warn('Stream delete received', {
      guildId: this.guildId,
      channelId: this.channelId,
      reason,
      unavailable: payload.d.unavailable ?? false,
    });

    if (!this.pendingAttempt) {
      return;
    }

    clearTimeout(this.pendingAttempt.timeout);
    const reject = this.pendingAttempt.reject;
    this.pendingAttempt = undefined;
    reject(
      new Error(
        `Discord deleted the active Go Live stream (reason: ${reason}).`
      )
    );
  }

  private async runAttempt(attempt: number): Promise<WebRtcConnection> {
    const voiceSessionId = this.voiceSessionIdProvider();
    if (!voiceSessionId) {
      throw new Error(
        'A voice session id is required before creating a Go Live stream.'
      );
    }

    this.cancelPendingAttempt();
    this.handshake.state = 'requesting';

    const streamKey = generateStreamKey(
      'guild',
      this.guildId,
      this.channelId,
      this.userId
    );
    this.logger.info('Stream create requested', {
      guildId: this.guildId,
      channelId: this.channelId,
      attempt,
      streamCreateKnown: this.handshake.sawStreamCreate,
      streamServerKnown: this.handshake.sawStreamServer,
    });

    this.session.sendGatewayOpcode(GatewayOpcode.StreamCreate, {
      type: 'guild',
      guild_id: this.guildId,
      channel_id: this.channelId,
      preferred_region: null,
    });
    this.session.sendGatewayOpcode(GatewayOpcode.StreamSetPaused, {
      stream_key: streamKey,
      paused: false,
    });

    await this.waitForHandshake(attempt);

    this.handshake.state = 'connecting_stream_ws';
    this.connection.setStreamContext(
      this.handshake.rtcServerId!,
      this.handshake.rtcChannelId!,
      this.handshake.streamKey!
    );
    this.connection.setSession(voiceSessionId);
    this.connection.setTokens(this.handshake.endpoint!, this.handshake.token!);
    return this.connection.waitUntilReady();
  }

  private waitForHandshake(_attempt: number): Promise<void> {
    if (this.hasHandshake()) {
      return Promise.resolve();
    }

    this.handshake.state = this.handshake.sawStreamCreate
      ? 'awaiting_stream_server'
      : this.handshake.sawStreamServer
        ? 'awaiting_stream_create'
        : 'requesting';

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAttempt = undefined;
        reject(
          new Error(
            'Timed out waiting for Discord to complete the Go Live handshake.'
          )
        );
      }, HANDSHAKE_TIMEOUT_MS);

      this.pendingAttempt = { resolve, reject, timeout };
    });
  }

  private maybeResolveAttempt(): void {
    if (!this.hasHandshake() || !this.pendingAttempt) {
      return;
    }

    clearTimeout(this.pendingAttempt.timeout);
    const resolve = this.pendingAttempt.resolve;
    this.pendingAttempt = undefined;
    resolve();
  }

  private cancelPendingAttempt(): void {
    if (!this.pendingAttempt) {
      return;
    }

    clearTimeout(this.pendingAttempt.timeout);
    this.pendingAttempt = undefined;
  }

  private hasHandshake(): boolean {
    return Boolean(
      this.handshake.streamKey &&
        this.handshake.rtcServerId &&
        this.handshake.rtcChannelId &&
        this.handshake.endpoint &&
        this.handshake.token
    );
  }
}

function backoffDelay(attempt: number): number {
  return 250 * attempt + Math.floor(Math.random() * 150);
}
