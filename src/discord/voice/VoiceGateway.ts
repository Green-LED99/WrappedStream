import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DaveMediaEncryptor } from '../dave/DaveEncryptor.js';
import { DaveSessionManager } from '../dave/DaveSessionManager.js';
import type { DaveModule, DaveTransientKeys } from '../dave/types.js';
import { codecPayloadType } from '../../transport/codec.js';
import { buildRemoteSdp } from '../../transport/sdp.js';
import { WebRtcConnection, type WebRtcParameters } from '../../transport/WebRtcConnection.js';
import type { Logger } from '../../utils/logger.js';
import { VoiceBinaryOpcode, VoiceOpcode } from './opcodes.js';
import type {
  VoiceGatewayResponse,
  VoiceReady,
  VoiceSelectProtocolAck,
  VoiceStreamDescriptor,
} from './types.js';
import {
  type ConnectionKind,
  type ReconnectDiagnostics,
  type ReconnectState,
  type RecoveryTrigger,
  classifyVoiceCloseCode,
} from './reconnect.js';

const READY_TIMEOUT_MS = 15_000;

export type VideoAttributes = {
  width: number;
  height: number;
  fps: number;
};

export const streamsSimulcast = [{ type: 'screen', rid: '100', quality: 100 }] as const;

type ConnectionState = {
  hasSession: boolean;
  hasToken: boolean;
  started: boolean;
  resuming: boolean;
};

export type VoiceGatewayCallbacks = {
  handleConnectionRecoveryRequested: (
    connection: BaseMediaConnection,
    diagnostics: ReconnectDiagnostics
  ) => void;
  handleConnectionFatal: (connection: BaseMediaConnection, error: Error) => void;
};

export abstract class BaseMediaConnection extends EventEmitter {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatIntervalMs: number | undefined;
  private lastHeartbeatSentAt: number | undefined;
  private lastHeartbeatAckAt: number | undefined;
  private missedHeartbeatAcks = 0;
  private lastCloseCode: number | undefined;
  private lastCloseReason: string | undefined;
  private webSocket: WebSocket | null = null;
  private connectionState: ConnectionState = {
    hasSession: false,
    hasToken: false,
    started: false,
    resuming: false,
  };
  private sequenceNumber = -1;
  private readonly webRtcWrapper: WebRtcConnection;
  private currentWebRtcParameters: (WebRtcParameters & { streams: VoiceStreamDescriptor[] }) | null = null;
  private closed = false;
  private voiceServer: string | null = null;
  private voiceToken: string | null = null;
  private sessionId: string | null = null;
  private daveProtocolVersion = 0;
  private daveSessionManager: DaveSessionManager | undefined;
  private readonly connectedUsers = new Set<string>();
  private ready = false;
  private reconnectAttempt = 0;
  private reconnectState: ReconnectState = 'idle';
  private speakingEnabled = false;
  private videoEnabled = false;
  private videoAttributes: VideoAttributes | undefined;

  public readonly daveEncryptor: DaveMediaEncryptor;

  public constructor(
    protected readonly callbacks: VoiceGatewayCallbacks,
    protected readonly dave: DaveModule,
    protected readonly logger: Logger,
    public readonly guildId: string | null,
    public readonly userId: string,
    public readonly channelId: string,
    private readonly transientKeys: DaveTransientKeys
  ) {
    super();
    this.daveEncryptor = new DaveMediaEncryptor(dave);
    this.webRtcWrapper = new WebRtcConnection(
      logger.child('webrtc'),
      () => this.daveEncryptor,
      () => this.daveReady,
      () => this.audioSsrc,
      () => this.videoSsrc
    );
  }

  public abstract get serverId(): string | null;
  public abstract get daveChannelId(): string;
  public abstract get connectionKind(): ConnectionKind;

  protected get voiceGatewayChannelId(): string {
    return this.channelId;
  }

  public get ws(): WebSocket | null {
    return this.webSocket;
  }

  public get voiceSessionId(): string | null {
    return this.sessionId;
  }

  public get webRtcConn(): WebRtcConnection {
    return this.webRtcWrapper;
  }

  public get webRtcParams(): (WebRtcParameters & { streams: VoiceStreamDescriptor[] }) | null {
    return this.currentWebRtcParameters;
  }

  public get daveReady(): boolean {
    return this.daveProtocolVersion > 0;
  }

  public get isReady(): boolean {
    return this.ready;
  }

  public get audioSsrc(): number {
    if (!this.currentWebRtcParameters) {
      throw new Error('Audio SSRC is not available yet.');
    }
    return this.currentWebRtcParameters.audioSsrc;
  }

  public get videoSsrc(): number {
    if (!this.currentWebRtcParameters) {
      throw new Error('Video SSRC is not available yet.');
    }
    return this.currentWebRtcParameters.videoSsrc;
  }

  public stop(): void {
    this.closed = true;
    this.ready = false;
    this.clearHeartbeatTimer();
    this.webRtcWrapper.close();
    this.webSocket?.close();
    this.webSocket = null;
    this.daveEncryptor.destroy();
  }

  public waitUntilReady(timeoutMs = READY_TIMEOUT_MS): Promise<WebRtcConnection> {
    if (this.ready) {
      return Promise.resolve(this.webRtcWrapper);
    }

    return new Promise<WebRtcConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for voice connection to become ready (${timeoutMs}ms).`));
      }, timeoutMs);

      const onReady = () => {
        cleanup();
        resolve(this.webRtcWrapper);
      };
      const onFatal = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('ready', onReady);
        this.off('fatal_disconnect', onFatal);
      };

      this.on('ready', onReady);
      this.on('fatal_disconnect', onFatal);
    });
  }

  public setSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.connectionState.hasSession = true;
    this.start();
  }

  public setTokens(server: string, token: string): void {
    this.voiceServer = server;
    this.voiceToken = token;
    this.connectionState.hasToken = true;
    this.start();
  }

  public prepareForServerReallocation(): void {
    if (this.closed) return;

    this.ready = false;
    this.currentWebRtcParameters = null;
    this.connectionState.started = false;
    this.connectionState.resuming = false;
    this.connectionState.hasToken = false;
    this.sequenceNumber = -1;
    this.voiceServer = null;
    this.voiceToken = null;
    this.lastCloseCode = undefined;
    this.lastCloseReason = undefined;
    this.heartbeatIntervalMs = undefined;
    this.lastHeartbeatSentAt = undefined;
    this.lastHeartbeatAckAt = undefined;
    this.missedHeartbeatAcks = 0;
    this.reconnectState = 'refreshing';
    this.clearHeartbeatTimer();
    this.resetDaveSession();
    this.webRtcWrapper.close();

    const socket = this.webSocket;
    this.webSocket = null;
    socket?.close();
  }

  public setSpeaking(speaking: boolean): void {
    this.speakingEnabled = speaking;
    if (!this.currentWebRtcParameters) return;
    this.sendOpcode(VoiceOpcode.Speaking, {
      delay: 0,
      speaking: speaking ? 1 : 0,
      ssrc: this.audioSsrc,
    });
  }

  public setVideoAttributes(enabled: false): void;
  public setVideoAttributes(enabled: true, attributes: VideoAttributes): void;
  public setVideoAttributes(enabled: boolean, attributes?: VideoAttributes): void {
    if (!enabled) {
      this.videoEnabled = false;
      this.videoAttributes = undefined;
      if (!this.currentWebRtcParameters) return;
      const { audioSsrc } = this.currentWebRtcParameters;
      this.sendOpcode(VoiceOpcode.Video, {
        audio_ssrc: audioSsrc,
        video_ssrc: 0,
        rtx_ssrc: 0,
        streams: [],
      });
      return;
    }

    if (!attributes) {
      throw new Error('Enabled video requires explicit video attributes.');
    }

    this.videoEnabled = true;
    this.videoAttributes = attributes;
    if (!this.currentWebRtcParameters) return;

    const { audioSsrc, videoSsrc, rtxSsrc } = this.currentWebRtcParameters;
    this.sendOpcode(VoiceOpcode.Video, {
      audio_ssrc: audioSsrc,
      video_ssrc: videoSsrc,
      rtx_ssrc: rtxSsrc,
      streams: [
        {
          type: 'video',
          rid: '100',
          ssrc: videoSsrc,
          active: true,
          quality: 100,
          rtx_ssrc: rtxSsrc,
          max_bitrate: 10_000 * 1_000,
          max_framerate: attributes.fps,
          max_resolution: {
            type: 'fixed',
            width: attributes.width,
            height: attributes.height,
          },
        },
      ],
    });
  }

  protected start(): void {
    if (!this.connectionState.hasSession || !this.connectionState.hasToken) return;
    if (this.connectionState.started) return;
    if (!this.voiceServer) {
      throw new Error('Voice server endpoint is missing.');
    }

    this.connectionState.started = true;
    this.webSocket = new WebSocket(`wss://${this.voiceServer}/?v=9`);
    this.webSocket.binaryType = 'arraybuffer';

    this.webSocket.addEventListener('open', () => {
      this.logger.info('Voice websocket opened', this.logContext());
      try {
        if (this.connectionState.resuming) {
          this.resume();
          return;
        }
        this.identify();
      } catch (error) {
        this.emitFatalDisconnect(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    this.webSocket.addEventListener('message', (event) => {
      void this.handleMessage(event.data).catch((error) => {
        this.emitFatalDisconnect(
          error instanceof Error ? error : new Error(String(error))
        );
      });
    });

    this.webSocket.addEventListener('close', (event) => {
      this.handleSocketClose(event.code, event.reason || undefined);
    });
  }

  protected async setProtocols(): Promise<void> {
    const peerConnection = await this.webRtcWrapper.initWebRtc();

    peerConnection.onStateChange((state: string) => {
      if (
        state === 'closed' &&
        !this.closed &&
        this.connectionState.started &&
        this.ws?.readyState === WebSocket.OPEN &&
        this.reconnectState === 'idle'
      ) {
        void this.setProtocols().catch((error) => {
          this.emitFatalDisconnect(
            error instanceof Error ? error : new Error(String(error))
          );
        });
      }
    });

    peerConnection.onLocalDescription((sdp: string) => {
      this.sendOpcode(VoiceOpcode.SelectProtocol, {
        protocol: 'webrtc',
        codecs: Object.values(codecPayloadType),
        data: sdp,
        sdp,
        rtc_connection_id: randomUUID(),
      });
    });

    peerConnection.setLocalDescription();

    await new Promise<void>((resolve) => {
      this.once('select_protocol_ack', () => resolve());
    });
  }

  protected sendOpcode(opcode: number, payload: Record<string, unknown>): void {
    if (this.webSocket?.readyState !== WebSocket.OPEN) return;
    this.webSocket.send(JSON.stringify({ op: opcode, d: payload }));
  }

  protected sendBinaryOpcode(opcode: VoiceBinaryOpcode, payload: Uint8Array): void {
    if (this.webSocket?.readyState !== WebSocket.OPEN) return;
    const frame = Buffer.allocUnsafe(payload.byteLength + 1);
    frame.writeUInt8(opcode, 0);
    Buffer.from(payload).copy(frame, 1);
    this.webSocket.send(frame);
  }

  private identify(): void {
    if (!this.serverId || !this.sessionId || !this.voiceToken) {
      throw new Error('Voice identify is missing required connection state.');
    }

    this.logger.info('Voice websocket identify sent', this.logContext());
    this.sendOpcode(VoiceOpcode.Identify, {
      server_id: this.serverId,
      user_id: this.userId,
      session_id: this.sessionId,
      token: this.voiceToken,
      channel_id: this.voiceGatewayChannelId,
      video: true,
      streams: streamsSimulcast,
      max_dave_protocol_version: this.dave.MaxSupportedProtocolVersion(),
    });
  }

  private resume(): void {
    if (!this.serverId || !this.sessionId || !this.voiceToken) {
      throw new Error('Voice resume is missing required connection state.');
    }

    this.logger.info('Voice websocket resume sent', this.logContext());
    this.sendOpcode(VoiceOpcode.Resume, {
      server_id: this.serverId,
      session_id: this.sessionId,
      token: this.voiceToken,
      channel_id: this.voiceGatewayChannelId,
      seq_ack: this.sequenceNumber,
    });
  }

  private async handleMessage(data: string | ArrayBuffer | Blob): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.handleBinaryMessage(Buffer.from(data));
      return;
    }

    if (data instanceof Blob) {
      this.handleBinaryMessage(Buffer.from(await data.arrayBuffer()));
      return;
    }

    const payload = JSON.parse(data) as VoiceGatewayResponse;
    if (typeof payload.seq === 'number') {
      this.sequenceNumber = payload.seq;
    }

    switch (payload.op) {
      case VoiceOpcode.Hello:
        this.setupHeartbeat(payload.d.heartbeat_interval);
        break;
      case VoiceOpcode.Heartbeat:
        this.sendHeartbeat(false);
        break;
      case VoiceOpcode.Ready:
        await this.handleReady(payload.d);
        break;
      case VoiceOpcode.SelectProtocolAck:
        await this.handleSelectProtocolAck(payload.d);
        break;
      case VoiceOpcode.HeartbeatAck:
        this.lastHeartbeatAckAt = performance.now();
        this.missedHeartbeatAcks = 0;
        break;
      case VoiceOpcode.Resumed:
        this.connectionState.resuming = false;
        this.reconnectState = 'idle';
        this.logger.info('Voice websocket resumed', this.logContext());
        break;
      case VoiceOpcode.ClientsConnect:
        for (const userId of payload.d.user_ids) {
          this.connectedUsers.add(userId);
          this.daveSessionManager?.createUser(userId);
        }
        break;
      case VoiceOpcode.ClientDisconnect:
        this.connectedUsers.delete(payload.d.user_id);
        this.daveSessionManager?.destroyUser(payload.d.user_id);
        break;
      case VoiceOpcode.DavePrepareTransition:
        this.daveSessionManager?.onPrepareTransition(
          payload.d.transition_id,
          payload.d.protocol_version
        );
        break;
      case VoiceOpcode.DaveExecuteTransition:
        this.daveSessionManager?.onExecuteTransition(payload.d.transition_id);
        this.daveProtocolVersion =
          this.daveSessionManager?.getProtocolVersion() ?? this.daveProtocolVersion;
        break;
      case VoiceOpcode.DavePrepareEpoch:
        this.daveProtocolVersion = payload.d.protocol_version;
        this.daveSessionManager?.onPrepareEpoch(payload.d.epoch, payload.d.protocol_version);
        break;
      default:
        break;
    }
  }

  private handleBinaryMessage(message: Buffer): void {
    this.sequenceNumber = message.readUInt16BE(0);
    const opcode = message.readUInt8(2) as VoiceBinaryOpcode;

    switch (opcode) {
      case VoiceBinaryOpcode.MlsExternalSender:
        this.daveSessionManager?.onExternalSenderPackage(message.subarray(3));
        break;
      case VoiceBinaryOpcode.MlsProposals:
        this.daveSessionManager?.onMlsProposals(message.subarray(3));
        break;
      case VoiceBinaryOpcode.MlsAnnounceCommitTransition:
        this.daveSessionManager?.onMlsAnnounceCommitTransition(
          message.readUInt16BE(3),
          message.subarray(5)
        );
        break;
      case VoiceBinaryOpcode.MlsWelcome:
        this.daveSessionManager?.onMlsWelcome(message.readUInt16BE(3), message.subarray(5));
        break;
      default:
        break;
    }
  }

  private async handleReady(ready: VoiceReady): Promise<void> {
    const stream = ready.streams[0];
    if (!stream) {
      throw new Error('Voice ready payload did not include a video stream descriptor.');
    }

    this.currentWebRtcParameters = {
      address: ready.ip,
      port: ready.port,
      audioSsrc: ready.ssrc,
      videoSsrc: stream.ssrc,
      rtxSsrc: stream.rtx_ssrc,
      streams: ready.streams,
    };

    await this.setProtocols();
    this.connectionState.resuming = false;
    this.ready = true;
    this.reconnectState = 'idle';
    this.reapplyMediaState();
    this.emit('ready', this.webRtcWrapper);
  }

  private async handleSelectProtocolAck(payload: VoiceSelectProtocolAck): Promise<void> {
    if (!payload.sdp) {
      throw new Error('Discord did not return an SDP answer for the WebRTC stream.');
    }

    this.daveProtocolVersion = payload.dave_protocol_version;
    this.ensureDaveSessionManager();
    this.daveSessionManager!.onSelectProtocolAck(payload.dave_protocol_version);

    const remoteSdp = buildRemoteSdp(payload.sdp);
    this.webRtcWrapper.getPeerConnection()?.setRemoteDescription(remoteSdp, 'answer');

    this.emit('select_protocol_ack');
  }

  private ensureDaveSessionManager(): void {
    if (this.daveSessionManager) return;

    this.daveSessionManager = new DaveSessionManager(
      this.dave,
      this.userId,
      this.daveChannelId,
      this.transientKeys,
      this.logger.child('dave'),
      (opcode, payload) => this.sendOpcode(opcode, payload),
      (opcode, payload) => this.sendBinaryOpcode(opcode as VoiceBinaryOpcode, payload),
      (keyRatchet) => this.daveEncryptor.updateSelfKeyRatchet(keyRatchet)
    );

    for (const userId of this.connectedUsers) {
      this.daveSessionManager.createUser(userId);
    }
  }

  private setupHeartbeat(intervalMs: number): void {
    this.heartbeatIntervalMs = intervalMs;
    this.lastHeartbeatAckAt ??= performance.now();
    this.missedHeartbeatAcks = 0;
    this.clearHeartbeatTimer();

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
    this.sendHeartbeat();
  }

  private sendHeartbeat(recordMissedAck = true): void {
    if (this.webSocket?.readyState !== WebSocket.OPEN) return;

    if (
      recordMissedAck &&
      this.lastHeartbeatSentAt !== undefined &&
      (this.lastHeartbeatAckAt ?? 0) < this.lastHeartbeatSentAt
    ) {
      this.missedHeartbeatAcks += 1;
    } else if (recordMissedAck) {
      this.missedHeartbeatAcks = 0;
    }

    if (recordMissedAck && this.missedHeartbeatAcks >= 2) {
      this.logger.warn('Voice heartbeat timed out', this.logContext({ trigger: 'heartbeat_timeout' }));
      this.requestResume('heartbeat_timeout');
      return;
    }

    this.lastHeartbeatSentAt = performance.now();
    this.sendOpcode(VoiceOpcode.Heartbeat, {
      t: Date.now(),
      seq_ack: this.sequenceNumber,
    });
  }

  private handleSocketClose(code: number, reason: string | undefined): void {
    const wasStarted = this.connectionState.started;

    this.lastCloseCode = code;
    this.lastCloseReason = reason;
    this.ready = false;
    this.clearHeartbeatTimer();
    this.connectionState.started = false;

    const classification = classifyVoiceCloseCode(code);
    this.logger.warn('Voice websocket closed', this.logContext({ classification }));

    if (this.closed || !wasStarted) return;

    if (classification === 'resume') {
      this.reconnectState = 'resuming';
      this.connectionState.resuming = true;
      this.start();
      return;
    }

    if (classification === 'refresh') {
      this.requestRecovery('socket_close');
      return;
    }

    this.reconnectState = 'failed';
    this.emitFatalDisconnect(
      new Error(`Discord closed the voice websocket with a fatal close code (${code}).`)
    );
  }

  private requestRecovery(trigger: RecoveryTrigger): void {
    if (this.closed || this.reconnectState === 'refreshing' || this.reconnectState === 'failed') return;

    this.reconnectState = 'refreshing';
    this.ready = false;
    this.connectionState.started = false;
    this.clearHeartbeatTimer();
    const socket = this.webSocket;
    this.webSocket = null;
    socket?.close();

    const diagnostics: ReconnectDiagnostics = {
      connectionKind: this.connectionKind,
      attempt: this.reconnectAttempt,
      trigger,
      state: this.reconnectState,
      ...(this.lastCloseCode !== undefined ? { closeCode: this.lastCloseCode } : {}),
      ...(this.lastCloseReason ? { closeReason: this.lastCloseReason } : {}),
    };
    this.callbacks.handleConnectionRecoveryRequested(this, diagnostics);
  }

  private requestResume(trigger: RecoveryTrigger): void {
    if (this.closed || this.reconnectState === 'resuming' || this.reconnectState === 'failed') return;

    this.ready = false;
    this.reconnectState = 'resuming';
    this.connectionState.resuming = true;
    this.clearHeartbeatTimer();

    const socket = this.webSocket;
    this.webSocket = null;
    socket?.close(3990, trigger);
  }

  private emitFatalDisconnect(error: Error): void {
    if (this.reconnectState !== 'failed') {
      this.reconnectState = 'failed';
    }
    this.emit('fatal_disconnect', error);
    this.callbacks.handleConnectionFatal(this, error);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private resetDaveSession(): void {
    this.daveSessionManager = undefined;
    this.daveProtocolVersion = 0;
    this.daveEncryptor.updateSelfKeyRatchet(null);
  }

  private reapplyMediaState(): void {
    if (this.speakingEnabled) {
      this.setSpeaking(true);
    } else {
      this.setSpeaking(false);
    }

    if (this.videoEnabled && this.videoAttributes) {
      this.setVideoAttributes(true, this.videoAttributes);
      return;
    }
    this.setVideoAttributes(false);
  }

  private logContext(context?: Record<string, unknown>): Record<string, unknown> {
    return {
      connectionKind: this.connectionKind,
      guildId: this.guildId,
      channelId: this.channelId,
      reconnectAttempt: this.reconnectAttempt,
      reconnectState: this.reconnectState,
      ...(this.lastCloseCode !== undefined ? { closeCode: this.lastCloseCode } : {}),
      ...(this.lastCloseReason ? { closeReason: this.lastCloseReason } : {}),
      ...context,
    };
  }
}

// ── Concrete subclasses ──────────────────────────────────────

export class VoiceConnection extends BaseMediaConnection {
  public override get connectionKind(): ConnectionKind {
    return 'voice';
  }

  public override get serverId(): string | null {
    return this.guildId ?? this.channelId;
  }

  public override get daveChannelId(): string {
    return this.channelId;
  }
}

export class StreamConnection extends BaseMediaConnection {
  private rtcServerId: string | null = null;
  private rtcChannelId: string | null = null;
  private currentStreamKey: string | null = null;

  public override get connectionKind(): ConnectionKind {
    return 'stream';
  }

  public override get serverId(): string | null {
    return this.rtcServerId;
  }

  public override get daveChannelId(): string {
    if (!this.rtcChannelId) {
      throw new Error('RTC channel id has not been set yet.');
    }
    return this.rtcChannelId;
  }

  protected override get voiceGatewayChannelId(): string {
    if (!this.rtcChannelId) {
      throw new Error('RTC channel id has not been set yet.');
    }
    return this.rtcChannelId;
  }

  public setStreamContext(rtcServerId: string, rtcChannelId: string, streamKey: string): void {
    this.rtcServerId = rtcServerId;
    this.rtcChannelId = rtcChannelId;
    this.currentStreamKey = streamKey;
  }

  public get streamKey(): string | null {
    return this.currentStreamKey;
  }
}
