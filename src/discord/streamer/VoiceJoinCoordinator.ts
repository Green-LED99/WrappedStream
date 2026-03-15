import { setTimeout as sleep } from 'node:timers/promises';
import type {
  GatewayVoiceServerUpdate,
  GatewayVoiceStateUpdate,
} from '../gateway/events.js';
import { GatewayOpcode } from '../gateway/opcodes.js';
import type { GatewayClient } from '../gateway/GatewayClient.js';
import type { VoiceConnection } from '../voice/VoiceGateway.js';
import type { WebRtcConnection } from '../../transport/WebRtcConnection.js';
import type { Logger } from '../../utils/logger.js';

const INITIAL_JOIN_ATTEMPTS = 3;
const HANDSHAKE_TIMEOUT_MS = 8_000;

type VoiceHandshakeState = {
  state: string;
  sessionId: string | null;
  endpoint: string | null;
  token: string | null;
  sawVoiceState: boolean;
  sawVoiceServer: boolean;
  sawNullEndpoint: boolean;
  lastChannelId: string | null;
};

export class VoiceJoinCoordinator {
  private handshake: VoiceHandshakeState = {
    state: 'idle',
    sessionId: null,
    endpoint: null,
    token: null,
    sawVoiceState: false,
    sawVoiceServer: false,
    sawNullEndpoint: false,
    lastChannelId: null,
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
    private readonly connection: VoiceConnection,
    private readonly logger: Logger,
    private readonly guildId: string,
    private readonly channelId: string
  ) {}

  public async connectInitial(): Promise<WebRtcConnection> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= INITIAL_JOIN_ATTEMPTS; attempt += 1) {
      try {
        return await this.runAttempt(attempt);
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error('Voice join failed.');
        this.handshake.state = 'failed';
        this.logger.warn('Voice join attempt failed', {
          guildId: this.guildId,
          channelId: this.channelId,
          attempt,
          message: lastError.message,
        });
        if (attempt < INITIAL_JOIN_ATTEMPTS) {
          await sleep(backoffDelay(attempt));
        }
      }
    }

    throw lastError ?? new Error('Voice join failed.');
  }

  public async refresh(attempt: number): Promise<void> {
    await this.runAttempt(attempt);
  }

  public handleVoiceStateUpdate(payload: GatewayVoiceStateUpdate): void {
    if (payload.d.channel_id !== this.channelId) {
      this.handshake.lastChannelId = payload.d.channel_id ?? null;
      return;
    }

    this.handshake.sawVoiceState = true;
    this.handshake.lastChannelId = payload.d.channel_id;
    this.handshake.sessionId = payload.d.session_id;
    this.handshake.state = this.handshake.endpoint
      ? 'connecting_voice_ws'
      : 'awaiting_voice_server';
    this.logger.info('Voice state received', {
      guildId: this.guildId,
      channelId: this.channelId,
      sessionId: payload.d.session_id,
    });
    this.maybeResolveAttempt();
  }

  public handleVoiceServerUpdate(payload: GatewayVoiceServerUpdate): void {
    if (payload.d.guild_id !== this.guildId) {
      return;
    }

    if (payload.d.channel_id && payload.d.channel_id !== this.channelId) {
      return;
    }

    this.handshake.sawVoiceServer = true;
    if (!payload.d.endpoint) {
      this.handshake.endpoint = null;
      this.handshake.token = null;
      this.handshake.sawNullEndpoint = true;
      this.logger.warn(
        'Voice server reallocated, waiting for a replacement endpoint',
        {
          guildId: this.guildId,
          channelId: this.channelId,
        }
      );
      return;
    }

    this.handshake.endpoint = payload.d.endpoint;
    this.handshake.token = payload.d.token;
    this.handshake.state = this.handshake.sessionId
      ? 'connecting_voice_ws'
      : 'awaiting_voice_state';
    this.logger.info('Voice server received', {
      guildId: this.guildId,
      channelId: this.channelId,
      endpoint: payload.d.endpoint,
    });
    this.maybeResolveAttempt();
  }

  private async runAttempt(attempt: number): Promise<WebRtcConnection> {
    this.cancelPendingAttempt();
    this.handshake.state = 'requesting';

    this.logger.info('Voice join requested', {
      guildId: this.guildId,
      channelId: this.channelId,
      attempt,
      sessionKnown: Boolean(this.handshake.sessionId),
      serverKnown: Boolean(this.handshake.endpoint && this.handshake.token),
    });

    this.session.sendGatewayOpcode(GatewayOpcode.VoiceStateUpdate, {
      guild_id: this.guildId,
      channel_id: this.channelId,
      self_mute: false,
      self_deaf: true,
      self_video: false,
    });

    await this.waitForHandshake(attempt);

    this.handshake.state = 'connecting_voice_ws';
    this.connection.setSession(this.handshake.sessionId!);
    this.connection.setTokens(this.handshake.endpoint!, this.handshake.token!);
    return this.connection.waitUntilReady();
  }

  private waitForHandshake(_attempt: number): Promise<void> {
    if (this.hasHandshake()) {
      return Promise.resolve();
    }

    this.handshake.state = this.handshake.sawVoiceState
      ? 'awaiting_voice_server'
      : this.handshake.sawVoiceServer
        ? 'awaiting_voice_state'
        : 'requesting';

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAttempt = undefined;
        reject(
          new Error(
            'Timed out waiting for Discord to complete the voice join handshake.'
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
      this.handshake.sessionId &&
        this.handshake.endpoint &&
        this.handshake.token
    );
  }
}

function backoffDelay(attempt: number): number {
  return 250 * attempt + Math.floor(Math.random() * 150);
}
