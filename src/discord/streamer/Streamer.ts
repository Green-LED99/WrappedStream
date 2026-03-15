import type { DaveModule, DaveTransientKeys } from '../dave/types.js';
import type { GatewayClient } from '../gateway/GatewayClient.js';
import type {
  GatewayEvent,
  GatewayStreamCreate,
  GatewayStreamDelete,
  GatewayStreamServerUpdate,
  GatewayVoiceServerUpdate,
  GatewayVoiceStateUpdate,
} from '../gateway/events.js';
import { GatewayOpcode } from '../gateway/opcodes.js';
import type { BaseMediaConnection } from '../voice/VoiceGateway.js';
import { StreamConnection, VoiceConnection } from '../voice/VoiceGateway.js';
import type { VoiceGatewayCallbacks } from '../voice/VoiceGateway.js';
import type { ReconnectDiagnostics } from '../voice/reconnect.js';
import type { WebRtcConnection } from '../../transport/WebRtcConnection.js';
import type { Logger } from '../../utils/logger.js';
import { VoiceJoinCoordinator } from './VoiceJoinCoordinator.js';
import { StreamJoinCoordinator } from './StreamJoinCoordinator.js';
import { generateStreamKey, parseStreamKey } from './utils.js';

const RUNTIME_RECOVERY_ATTEMPTS = 3;

type DesiredVoiceState = {
  guildId: string;
  channelId: string;
};

type FatalListener = (error: Error) => void;

export class Streamer implements VoiceGatewayCallbacks {
  private voiceConnection: VoiceConnection | undefined;
  private streamConnection: StreamConnection | undefined;
  private voiceJoinCoordinator: VoiceJoinCoordinator | undefined;
  private streamJoinCoordinator: StreamJoinCoordinator | undefined;
  private desiredVoice: DesiredVoiceState | undefined;
  private desiredStream: DesiredVoiceState | undefined;
  private readonly rawListener: (event: GatewayEvent) => void;
  private readonly fatalListeners = new Set<FatalListener>();
  private runtimeRecoveryCount = 0;
  private recoveryPromise: Promise<void> | null = null;
  private transientKeys: DaveTransientKeys | undefined;

  public constructor(
    private readonly session: GatewayClient,
    private readonly dave: DaveModule,
    private readonly logger: Logger
  ) {
    this.rawListener = (event) => {
      this.handleRawEvent(event);
    };

    this.session.onRaw(this.rawListener);
  }

  public destroy(): void {
    this.session.offRaw(this.rawListener);
    this.clearTransientKeys();
  }

  public onFatal(listener: FatalListener): void {
    this.fatalListeners.add(listener);
  }

  public offFatal(listener: FatalListener): void {
    this.fatalListeners.delete(listener);
  }

  public async joinVoice(
    guildId: string,
    channelId: string
  ): Promise<WebRtcConnection> {
    const currentUser = this.session.currentUser();
    if (!currentUser) {
      throw new Error('The gateway session is not ready.');
    }

    this.desiredVoice = { guildId, channelId };
    this.runtimeRecoveryCount = 0;
    this.clearTransientKeys();
    this.transientKeys = new this.dave.TransientKeys();

    const preflight = await this.session.preflightVoiceJoin(guildId, channelId);
    if (preflight.warnings.length > 0) {
      this.logger.warn('Voice join preflight reported potential blockers', {
        guildId,
        channelId,
        ...preflight,
      });
    } else {
      this.logger.info('Voice join preflight completed', {
        guildId,
        channelId,
        ...preflight,
      });
    }

    const voiceConnection = new VoiceConnection(
      this,
      this.dave,
      this.logger.child('voice'),
      guildId,
      currentUser.id,
      channelId,
      this.transientKeys
    );
    this.voiceConnection = voiceConnection;
    this.voiceJoinCoordinator = new VoiceJoinCoordinator(
      this.session,
      voiceConnection,
      this.logger.child('voice-join'),
      guildId,
      channelId
    );

    return this.voiceJoinCoordinator.connectInitial();
  }

  public async createStream(): Promise<WebRtcConnection> {
    if (!this.voiceConnection || !this.desiredVoice) {
      throw new Error(
        'A voice connection must exist before creating a stream.'
      );
    }

    const currentUser = this.session.currentUser();
    if (!currentUser) {
      throw new Error('The gateway session is not ready.');
    }

    const { guildId, channelId } = this.voiceConnection;
    this.desiredStream = { guildId: guildId ?? channelId, channelId };

    const streamConnection = new StreamConnection(
      this,
      this.dave,
      this.logger.child('stream'),
      guildId,
      currentUser.id,
      channelId,
      this.getTransientKeys()
    );
    this.streamConnection = streamConnection;
    this.streamJoinCoordinator = new StreamJoinCoordinator(
      this.session,
      streamConnection,
      this.logger.child('stream-join'),
      this.desiredStream.guildId,
      this.desiredStream.channelId,
      currentUser.id,
      () => this.voiceConnection?.voiceSessionId ?? null
    );

    const connection = await this.streamJoinCoordinator.connectInitial();
    this.logger.info('Stream connection is ready; signaling video', {
      guildId: this.desiredStream.guildId,
      channelId: this.desiredStream.channelId,
    });
    this.signalVideo(true);
    return connection;
  }

  public stopStream(): void {
    const currentUser = this.session.currentUser();
    if (!this.streamConnection || !this.voiceConnection || !currentUser) {
      return;
    }

    this.streamConnection.stop();
    this.session.sendGatewayOpcode(GatewayOpcode.StreamDelete, {
      stream_key: generateStreamKey(
        'guild',
        this.voiceConnection.guildId,
        this.voiceConnection.channelId,
        currentUser.id
      ),
    });
    this.signalVideo(false);
    this.streamJoinCoordinator = undefined;
    this.streamConnection = undefined;
    this.desiredStream = undefined;
  }

  public leaveVoice(): void {
    const guildId =
      this.voiceConnection?.guildId ?? this.desiredVoice?.guildId ?? null;
    this.stopStream();
    this.voiceConnection?.stop();
    this.voiceJoinCoordinator = undefined;
    this.voiceConnection = undefined;
    this.desiredVoice = undefined;
    this.session.sendGatewayOpcode(GatewayOpcode.VoiceStateUpdate, {
      guild_id: guildId,
      channel_id: null,
      self_mute: true,
      self_deaf: false,
      self_video: false,
    });
    this.clearTransientKeys();
  }

  public get streamConn(): StreamConnection | undefined {
    return this.streamConnection;
  }

  public signalVideo(enabled: boolean): void {
    if (!this.voiceConnection) {
      return;
    }

    this.session.sendGatewayOpcode(GatewayOpcode.VoiceStateUpdate, {
      guild_id: this.voiceConnection.guildId,
      channel_id: this.voiceConnection.channelId,
      self_mute: false,
      self_deaf: true,
      self_video: enabled,
    });
  }

  public handleConnectionRecoveryRequested(
    connection: BaseMediaConnection,
    diagnostics: ReconnectDiagnostics
  ): void {
    if (this.recoveryPromise || !this.isActiveConnection(connection)) {
      return;
    }

    this.recoveryPromise = this.recoverConnection(connection, diagnostics)
      .catch((error) => {
        this.handleConnectionFatal(
          connection,
          error instanceof Error ? error : new Error(String(error))
        );
      })
      .finally(() => {
        this.recoveryPromise = null;
      });
  }

  public handleConnectionFatal(
    connection: BaseMediaConnection,
    error: Error
  ): void {
    if (!this.isActiveConnection(connection)) {
      return;
    }

    this.logger.error('Connection failed permanently', {
      connectionKind: connection.connectionKind,
      guildId: connection.guildId,
      channelId: connection.channelId,
      message: error.message,
    });

    for (const listener of this.fatalListeners) {
      listener(error);
    }
  }

  private handleRawEvent(event: GatewayEvent): void {
    const currentUser = this.session.currentUser();
    if (!currentUser) {
      return;
    }

    switch (event.t) {
      case 'VOICE_STATE_UPDATE':
        this.handleVoiceStateUpdate(currentUser.id, event);
        break;
      case 'VOICE_SERVER_UPDATE':
        this.handleVoiceServerUpdate(event);
        break;
      case 'STREAM_CREATE':
        this.handleStreamCreate(currentUser.id, event);
        break;
      case 'STREAM_SERVER_UPDATE':
        this.handleStreamServerUpdate(currentUser.id, event);
        break;
      case 'STREAM_DELETE':
        this.handleStreamDelete(currentUser.id, event);
        break;
      default:
        break;
    }
  }

  private handleVoiceStateUpdate(
    currentUserId: string,
    payload: GatewayVoiceStateUpdate
  ): void {
    if (
      payload.d.user_id !== currentUserId ||
      !this.voiceConnection ||
      !this.desiredVoice
    ) {
      return;
    }

    if (
      this.voiceConnection.guildId &&
      payload.d.guild_id &&
      payload.d.guild_id !== this.voiceConnection.guildId
    ) {
      return;
    }

    if (!this.voiceConnection.isReady && this.voiceJoinCoordinator) {
      this.voiceJoinCoordinator.handleVoiceStateUpdate(payload);
      return;
    }

    if (payload.d.channel_id === this.desiredVoice.channelId) {
      this.voiceConnection.setSession(payload.d.session_id);
      if (this.streamConnection && this.desiredStream) {
        this.streamConnection.setSession(payload.d.session_id);
      }
      return;
    }

    this.handleConnectionFatal(
      this.voiceConnection,
      new Error(
        'Discord moved or disconnected the user from the voice channel.'
      )
    );
  }

  private handleVoiceServerUpdate(payload: GatewayVoiceServerUpdate): void {
    if (!this.voiceConnection || !this.desiredVoice) {
      return;
    }

    if (payload.d.guild_id !== this.desiredVoice.guildId) {
      return;
    }

    if (
      payload.d.channel_id &&
      payload.d.channel_id !== this.desiredVoice.channelId
    ) {
      return;
    }

    if (!this.voiceConnection.isReady && this.voiceJoinCoordinator) {
      this.voiceJoinCoordinator.handleVoiceServerUpdate(payload);
      return;
    }

    if (!payload.d.endpoint) {
      this.logger.warn(
        'Voice server endpoint was cleared; waiting for recovery',
        {
          guildId: this.desiredVoice.guildId,
          channelId: this.desiredVoice.channelId,
        }
      );
      this.voiceConnection.prepareForServerReallocation();
      return;
    }

    this.voiceConnection.setTokens(payload.d.endpoint, payload.d.token);
  }

  private handleStreamCreate(
    currentUserId: string,
    payload: GatewayStreamCreate
  ): void {
    if (!this.streamConnection || !this.desiredStream) {
      return;
    }

    const parsed = parseStreamKey(payload.d.stream_key);
    if (
      parsed.type !== 'guild' ||
      parsed.userId !== currentUserId ||
      parsed.channelId !== this.desiredStream.channelId ||
      parsed.guildId !== this.desiredStream.guildId
    ) {
      return;
    }

    if (!this.streamConnection.isReady && this.streamJoinCoordinator) {
      this.streamJoinCoordinator.handleStreamCreate(payload);
      return;
    }

    this.streamConnection.setStreamContext(
      payload.d.rtc_server_id,
      payload.d.rtc_channel_id,
      payload.d.stream_key
    );
    if (this.voiceConnection?.voiceSessionId) {
      this.streamConnection.setSession(this.voiceConnection.voiceSessionId);
    }
  }

  private handleStreamServerUpdate(
    currentUserId: string,
    payload: GatewayStreamServerUpdate
  ): void {
    if (!this.streamConnection || !this.desiredStream) {
      return;
    }

    const parsed = parseStreamKey(payload.d.stream_key);
    if (
      parsed.type !== 'guild' ||
      parsed.userId !== currentUserId ||
      parsed.channelId !== this.desiredStream.channelId ||
      parsed.guildId !== this.desiredStream.guildId
    ) {
      return;
    }

    if (!this.streamConnection.isReady && this.streamJoinCoordinator) {
      this.streamJoinCoordinator.handleStreamServerUpdate(payload);
      return;
    }

    if (!payload.d.endpoint) {
      this.logger.warn(
        'Stream server endpoint was cleared; waiting for recovery',
        {
          guildId: this.desiredStream.guildId,
          channelId: this.desiredStream.channelId,
        }
      );
      this.streamConnection.prepareForServerReallocation();
      return;
    }

    this.streamConnection.setTokens(payload.d.endpoint, payload.d.token);
  }

  private handleStreamDelete(
    currentUserId: string,
    payload: GatewayStreamDelete
  ): void {
    if (!this.streamConnection || !this.desiredStream) {
      return;
    }

    const parsed = parseStreamKey(payload.d.stream_key);
    if (
      parsed.type !== 'guild' ||
      parsed.userId !== currentUserId ||
      parsed.channelId !== this.desiredStream.channelId ||
      parsed.guildId !== this.desiredStream.guildId
    ) {
      return;
    }

    if (!this.streamConnection.isReady && this.streamJoinCoordinator) {
      this.streamJoinCoordinator.handleStreamDelete(payload);
      return;
    }

    if (payload.d.unavailable) {
      this.logger.warn('Stream became unavailable; attempting recovery', {
        guildId: this.desiredStream.guildId,
        channelId: this.desiredStream.channelId,
        streamKey: payload.d.stream_key,
      });
      this.streamConnection.prepareForServerReallocation();
      this.handleConnectionRecoveryRequested(this.streamConnection, {
        connectionKind: 'stream',
        attempt: this.runtimeRecoveryCount,
        trigger: 'stream_delete',
        state: 'refreshing',
      });
      return;
    }

    this.handleConnectionFatal(
      this.streamConnection,
      new Error(
        `Discord deleted the active Go Live stream (reason: ${payload.d.reason ?? 'unknown'}).`
      )
    );
  }

  private async recoverConnection(
    connection: BaseMediaConnection,
    diagnostics: ReconnectDiagnostics
  ): Promise<void> {
    const nextAttempt = this.runtimeRecoveryCount + 1;
    if (nextAttempt > RUNTIME_RECOVERY_ATTEMPTS) {
      throw new Error(
        'Exceeded the maximum number of runtime reconnect attempts.'
      );
    }

    this.runtimeRecoveryCount = nextAttempt;
    this.logger.warn('Reconnect attempt started', {
      ...diagnostics,
      attempt: nextAttempt,
      guildId: connection.guildId,
      channelId: connection.channelId,
    });

    if (connection.connectionKind === 'voice') {
      await this.recoverVoice(nextAttempt);
    } else {
      await this.recoverStream(nextAttempt);
    }

    this.logger.info('Reconnect attempt completed', {
      connectionKind: connection.connectionKind,
      guildId: connection.guildId,
      channelId: connection.channelId,
      attempt: nextAttempt,
      trigger: diagnostics.trigger,
    });
  }

  private async recoverVoice(attempt: number): Promise<void> {
    if (
      !this.voiceConnection ||
      !this.voiceJoinCoordinator ||
      !this.desiredVoice
    ) {
      throw new Error(
        'No active voice connection is available for recovery.'
      );
    }

    await this.voiceJoinCoordinator.refresh(attempt);

    if (
      this.streamConnection &&
      this.streamJoinCoordinator &&
      this.desiredStream
    ) {
      await this.streamJoinCoordinator.refresh(attempt);
      this.logger.info(
        'Recovered stream connection is ready; signaling video',
        {
          guildId: this.desiredStream.guildId,
          channelId: this.desiredStream.channelId,
          attempt,
        }
      );
      this.signalVideo(true);
    }
  }

  private async recoverStream(attempt: number): Promise<void> {
    if (
      !this.streamConnection ||
      !this.streamJoinCoordinator ||
      !this.desiredStream
    ) {
      throw new Error(
        'No active stream connection is available for recovery.'
      );
    }

    await this.streamJoinCoordinator.refresh(attempt);
    this.logger.info(
      'Recovered stream connection is ready; signaling video',
      {
        guildId: this.desiredStream.guildId,
        channelId: this.desiredStream.channelId,
        attempt,
      }
    );
    this.signalVideo(true);
  }

  private isActiveConnection(connection: BaseMediaConnection): boolean {
    return (
      connection === this.voiceConnection ||
      connection === this.streamConnection
    );
  }

  private getTransientKeys(): DaveTransientKeys {
    if (!this.transientKeys) {
      this.transientKeys = new this.dave.TransientKeys();
    }

    return this.transientKeys;
  }

  private clearTransientKeys(): void {
    this.transientKeys = undefined;
  }
}
