import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../../utils/logger.js';
import type { GatewayEvent, GatewayUser, RawGatewayListener } from './events.js';
import { GatewayOpcode } from './opcodes.js';

const GATEWAY_VERSION = 9;
const READY_TIMEOUT_MS = 20_000;
const GUILD_CACHE_WAIT_MS = 2_000;
const GATEWAY_CAPABILITIES = 16_381;
const CONNECT_PERMISSION = 1_048_576n;
const STREAM_PERMISSION = 512n;
const ADMINISTRATOR_PERMISSION = 8n;
const ALL_PERMISSIONS = (1n << 53n) - 1n;
const STAGE_CHANNEL_TYPE = 13;
const SUPPORTED_VOICE_CHANNEL_TYPES = new Set([2]);

type GatewayCloseClassification = 'resume' | 'identify' | 'fatal' | 'auth';

type GatewayPayload = {
  op: number;
  t?: string;
  s?: number | null;
  d: unknown;
};

type GatewayReadyPayload = {
  user: GatewayUser;
  session_id: string;
  resume_gateway_url?: string;
  guilds?: unknown[];
};

type GatewayGuildRole = {
  id: string;
  permissions: bigint;
};

type GatewayChannelOverwrite = {
  id: string;
  type: number;
  allow: bigint;
  deny: bigint;
};

type GatewayChannelSnapshot = {
  id: string;
  guildId: string;
  type: number;
  name: string | null;
  userLimit: number | null;
  permissionOverwrites: GatewayChannelOverwrite[];
};

type GatewayGuildSnapshotInternal = {
  id: string;
  ownerId: string | null;
  maxVideoChannelUsers: number | null;
  maxStageVideoChannelUsers: number | null;
  roles: Map<string, GatewayGuildRole>;
  channels: Map<string, GatewayChannelSnapshot>;
  selfRoleIds: string[] | null;
  voiceStatesByUserId: Map<string, string | null>;
};

type GatewayDispatchGuild = {
  id: string;
  owner_id?: string;
  max_video_channel_users?: number;
  max_stage_video_channel_users?: number;
  roles?: Array<{ id?: string; permissions?: string }>;
  channels?: Array<{
    id?: string;
    guild_id?: string;
    type?: number;
    name?: string;
    user_limit?: number;
    permission_overwrites?: Array<{
      id?: string;
      type?: number | string;
      allow?: string;
      deny?: string;
    }>;
  }>;
  members?: Array<{
    user?: { id?: string };
    roles?: string[];
  }>;
  voice_states?: Array<{
    user_id?: string;
    channel_id?: string | null;
  }>;
};

export type VoiceJoinPreflight = {
  channelType: number | null;
  warnings: string[];
  permissions?: {
    connect: boolean;
    stream: boolean;
  };
  occupancy?: {
    userLimit: number | null;
    connectedUsers: number;
    maxVideoChannelUsers: number | null;
  };
};

export type GatewaySessionSnapshot = {
  sessionId: string | null;
  seq: number | null;
  resumeGatewayUrl: string | null;
  heartbeatIntervalMs: number | null;
  lastHeartbeatAckAt: number | null;
};

export class GatewayClient {
  private readonly events = new EventEmitter();
  private readonly guilds = new Map<string, GatewayGuildSnapshotInternal>();
  private readonly rawListeners = new Set<RawGatewayListener>();
  private webSocket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs: number | null = null;
  private heartbeatAckDeadlineAt: number | null = null;
  private lastHeartbeatAckAt: number | null = null;
  private seq: number | null = null;
  private gatewaySessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private currentGatewayUrl: string | null = null;
  private currentUserRef: GatewayUser | null = null;
  private reconnecting = false;
  private destroyed = false;
  private token: string | null = null;
  private readonly clientLaunchId = randomUUID();
  private clientHeartbeatSessionId = randomUUID();

  public constructor(private readonly logger: Logger) {}

  public async login(token: string): Promise<void> {
    this.token = token;
    this.destroyed = false;
    const gatewayUrl = await this.fetchGatewayUrl();
    this.currentGatewayUrl = gatewayUrl;
    this.connect(gatewayUrl, false);
    await this.waitForReady();
  }

  public destroy(): void {
    this.destroyed = true;
    this.clearHeartbeatTimer();
    this.events.removeAllListeners();
    this.rawListeners.clear();
    this.webSocket?.close();
    this.webSocket = null;
  }

  public onRaw(listener: RawGatewayListener): void {
    this.rawListeners.add(listener);
  }

  public offRaw(listener: RawGatewayListener): void {
    this.rawListeners.delete(listener);
  }

  public sendGatewayOpcode(opcode: number, payload: unknown): void {
    if (this.webSocket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.webSocket.send(JSON.stringify({ op: opcode, d: payload }));
  }

  public currentUser(): GatewayUser | null {
    return this.currentUserRef;
  }

  public sessionSnapshot(): GatewaySessionSnapshot {
    return {
      sessionId: this.gatewaySessionId,
      seq: this.seq,
      resumeGatewayUrl: this.resumeGatewayUrl,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      lastHeartbeatAckAt: this.lastHeartbeatAckAt,
    };
  }

  public async preflightVoiceJoin(
    guildId: string,
    channelId: string
  ): Promise<VoiceJoinPreflight> {
    await this.waitForGuildCache(guildId);

    const guild = this.guilds.get(guildId);
    if (!guild) {
      return { channelType: null, warnings: ['guild_metadata_unavailable'] };
    }

    const channel = guild.channels.get(channelId);
    if (!channel) {
      return { channelType: null, warnings: ['channel_metadata_unavailable'] };
    }

    if (channel.type === STAGE_CHANNEL_TYPE) {
      throw new Error('Stage voice channels are not supported.');
    }

    if (!SUPPORTED_VOICE_CHANNEL_TYPES.has(channel.type)) {
      throw new Error(`The target channel type ${channel.type} is not voice-capable.`);
    }

    const warnings: string[] = [];
    const permissions = this.resolveChannelPermissions(guild, channel);
    if (permissions) {
      if (!permissions.connect) warnings.push('missing_connect_permission');
      if (!permissions.stream) warnings.push('missing_stream_permission');
    } else {
      warnings.push('permission_metadata_unavailable');
    }

    const connectedUsers = countConnectedUsers(guild.voiceStatesByUserId, channelId);
    if (channel.userLimit !== null && connectedUsers >= channel.userLimit) {
      warnings.push('channel_user_limit_reached');
    }

    return {
      channelType: channel.type,
      warnings,
      ...(permissions ? { permissions } : {}),
      occupancy: {
        connectedUsers,
        userLimit: channel.userLimit,
        maxVideoChannelUsers:
          channel.type === STAGE_CHANNEL_TYPE
            ? guild.maxStageVideoChannelUsers
            : guild.maxVideoChannelUsers,
      },
    };
  }

  /** Subscribe to internal events (ready, fatal, guild) */
  public on(event: string, listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener);
  }

  public off(event: string, listener: (...args: unknown[]) => void): void {
    this.events.off(event, listener);
  }

  public once(event: string, listener: (...args: unknown[]) => void): void {
    this.events.once(event, listener);
  }

  private async waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.currentUserRef) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for the Discord gateway READY event.'));
      }, timeoutMs);

      const onReady = () => {
        cleanup();
        resolve();
      };
      const onFatal = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.events.off('ready', onReady);
        this.events.off('fatal', onFatal);
      };

      this.events.on('ready', onReady);
      this.events.on('fatal', onFatal);
    });
  }

  private async waitForGuildCache(guildId: string): Promise<void> {
    if (this.guilds.has(guildId)) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, GUILD_CACHE_WAIT_MS);

      const onGuild = (receivedGuildId: string) => {
        if (receivedGuildId !== guildId) return;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.events.off('guild', onGuild);
      };

      this.events.on('guild', onGuild);
    });
  }

  private async fetchGatewayUrl(): Promise<string> {
    const response = await fetch(
      `https://discord.com/api/v${GATEWAY_VERSION}/gateway`,
      { method: 'GET' }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch the Discord gateway URL (status=${response.status}).`);
    }

    const payload = (await response.json()) as { url?: string };
    if (!payload.url) {
      throw new Error('Discord did not return a gateway URL.');
    }

    return `${payload.url}/?v=${GATEWAY_VERSION}&encoding=json`;
  }

  private connect(url: string, resume: boolean): void {
    this.webSocket = new WebSocket(url);
    this.webSocket.addEventListener('open', () => {
      this.logger.info('Gateway websocket opened', { resume, sessionId: this.gatewaySessionId });
    });
    this.webSocket.addEventListener('message', (event) => {
      void this.handleMessage(event.data).catch((error) => {
        this.emitFatal(error instanceof Error ? error : new Error(String(error)));
      });
    });
    this.webSocket.addEventListener('close', (event) => {
      void this.handleClose(event);
    });
  }

  private async handleMessage(data: string | ArrayBuffer | Blob): Promise<void> {
    const text = await toTextPayload(data);
    const payload = JSON.parse(text) as GatewayPayload;

    if (typeof payload.s === 'number') {
      this.seq = payload.s;
    }

    switch (payload.op) {
      case GatewayOpcode.Dispatch:
        this.handleDispatch(payload.t, payload.d);
        return;
      case GatewayOpcode.Heartbeat:
        this.sendHeartbeat();
        return;
      case GatewayOpcode.Hello:
        this.handleHello(payload.d);
        return;
      case GatewayOpcode.HeartbeatAck:
        this.lastHeartbeatAckAt = performance.now();
        this.heartbeatAckDeadlineAt = performance.now() + (this.heartbeatIntervalMs ?? 0) * 2;
        return;
      case GatewayOpcode.Reconnect:
        await this.reconnect(true, 'gateway_reconnect_opcode');
        return;
      case GatewayOpcode.InvalidSession:
        await this.handleInvalidSession(payload.d);
        return;
      default:
        return;
    }
  }

  private handleDispatch(eventType: string | undefined, data: unknown): void {
    if (!eventType) return;

    switch (eventType) {
      case 'READY':
        this.handleReady(data);
        return;
      case 'RESUMED':
        this.logger.info('Gateway session resumed', {
          sessionId: this.gatewaySessionId,
          seq: this.seq,
        });
        this.events.emit('ready');
        return;
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE':
        this.mergeGuild(data);
        return;
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
        this.mergeChannel(data);
        return;
      case 'CHANNEL_DELETE':
        this.deleteChannel(data);
        return;
      case 'VOICE_STATE_UPDATE':
        this.updateVoiceStateCache(data);
        break;
      default:
        break;
    }

    if (isSupportedGatewayEvent(eventType, data)) {
      for (const listener of this.rawListeners) {
        listener({ t: eventType, d: data } as GatewayEvent);
      }
    }
  }

  private handleReady(data: unknown): void {
    const payload = data as GatewayReadyPayload;
    this.currentUserRef = payload.user;
    this.gatewaySessionId = payload.session_id;
    this.resumeGatewayUrl = payload.resume_gateway_url ?? null;
    for (const guild of payload.guilds ?? []) {
      this.mergeGuild(guild);
    }
    this.logger.info('Gateway identified', {
      sessionId: this.gatewaySessionId,
      resumeGatewayUrl: this.resumeGatewayUrl,
      userId: this.currentUserRef?.id,
    });
    this.events.emit('ready');
  }

  private handleHello(data: unknown): void {
    const heartbeatInterval = getNumberField(data, 'heartbeat_interval');
    if (!heartbeatInterval) {
      throw new Error('Discord gateway hello payload was missing heartbeat_interval.');
    }

    this.heartbeatIntervalMs = heartbeatInterval;
    this.lastHeartbeatAckAt = performance.now();
    this.heartbeatAckDeadlineAt = this.lastHeartbeatAckAt + heartbeatInterval * 2;
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, heartbeatInterval);
    this.heartbeatTimer.unref?.();
    this.sendHeartbeat();

    if (this.gatewaySessionId && this.seq !== null) {
      this.sendResume();
      return;
    }

    this.sendIdentify();
  }

  private sendHeartbeat(): void {
    if (this.webSocket?.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    if (this.heartbeatAckDeadlineAt !== null && now > this.heartbeatAckDeadlineAt) {
      this.logger.warn('Gateway heartbeat timed out; forcing a resumable reconnect', {
        sessionId: this.gatewaySessionId,
        seq: this.seq,
      });
      this.webSocket.close(3_990, 'gateway_heartbeat_timeout');
      return;
    }

    this.sendGatewayOpcode(GatewayOpcode.Heartbeat, this.seq);
  }

  private sendIdentify(): void {
    if (!this.token) {
      throw new Error('The user gateway session is missing its token.');
    }

    const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    this.sendGatewayOpcode(GatewayOpcode.Identify, {
      token: this.token,
      capabilities: GATEWAY_CAPABILITIES,
      properties: {
        os: platformName(process.platform),
        browser: 'Discord Client',
        system_locale: locale,
        client_launch_id: this.clientLaunchId,
        client_heartbeat_session_id: this.clientHeartbeatSessionId,
      },
      compress: false,
      client_state: {
        guild_versions: {},
        highest_last_message_id: '0',
        read_state_version: 0,
        user_guild_settings_version: -1,
        user_settings_version: -1,
        api_code_version: 0,
      },
      presence: {
        status: 'unknown',
        since: 0,
        afk: false,
        activities: [],
      },
    });
  }

  private sendResume(): void {
    if (!this.token || !this.gatewaySessionId) {
      throw new Error('The user gateway session cannot resume without a token and session id.');
    }

    this.sendGatewayOpcode(GatewayOpcode.Resume, {
      token: this.token,
      session_id: this.gatewaySessionId,
      seq: this.seq,
    });
  }

  private async handleInvalidSession(data: unknown): Promise<void> {
    const resumable = typeof data === 'boolean' ? data : false;
    if (!resumable) {
      this.gatewaySessionId = null;
      this.seq = null;
      this.resumeGatewayUrl = null;
      this.currentUserRef = null;
    }

    await sleep(1_000 + Math.floor(Math.random() * 4_000));

    if (this.destroyed) return;

    if (this.webSocket?.readyState === WebSocket.OPEN) {
      if (resumable && this.gatewaySessionId && this.seq !== null) {
        this.sendResume();
      } else {
        this.sendIdentify();
      }
      return;
    }

    await this.reconnect(resumable, 'invalid_session');
  }

  private async handleClose(event: CloseEvent): Promise<void> {
    this.clearHeartbeatTimer();
    this.webSocket = null;

    if (this.destroyed) return;

    const classification = classifyGatewayCloseCode(event.code);
    this.logger.warn('Gateway websocket closed', {
      closeCode: event.code,
      closeReason: event.reason,
      classification,
      sessionId: this.gatewaySessionId,
      seq: this.seq,
    });

    if (classification === 'auth') {
      this.emitFatal(new Error(`Discord rejected the token (close code ${event.code}).`));
      return;
    }

    if (classification === 'fatal') {
      this.emitFatal(
        new Error(`Discord closed the gateway with a fatal error (close code ${event.code}).`)
      );
      return;
    }

    await this.reconnect(classification === 'resume', 'socket_close', event.code, event.reason);
  }

  private async reconnect(
    resume: boolean,
    reason: string,
    closeCode?: number,
    closeReason?: string
  ): Promise<void> {
    if (this.destroyed || this.reconnecting) return;

    this.reconnecting = true;
    try {
      this.logger.warn('Reconnecting gateway websocket', {
        reason,
        closeCode,
        closeReason,
        resume,
        sessionId: this.gatewaySessionId,
      });

      this.webSocket?.close();
      this.webSocket = null;

      const targetUrl =
        resume && this.resumeGatewayUrl
          ? `${trimTrailingSlash(this.resumeGatewayUrl)}/?v=${GATEWAY_VERSION}&encoding=json`
          : (this.currentGatewayUrl ?? (await this.fetchGatewayUrl()));

      if (!resume) {
        this.seq = null;
        this.gatewaySessionId = null;
        this.resumeGatewayUrl = null;
        this.currentUserRef = null;
      }

      this.connect(targetUrl, resume);
    } finally {
      this.reconnecting = false;
    }
  }

  private emitFatal(error: Error): void {
    this.logger.error('Gateway session failed', { message: error.message });
    this.events.emit('fatal', error);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Guild cache ──────────────────────────────────────────────

  private mergeGuild(data: unknown): void {
    const guild = data as GatewayDispatchGuild;
    if (!guild.id) return;

    const snapshot = this.guilds.get(guild.id) ?? {
      id: guild.id,
      ownerId: guild.owner_id ?? null,
      maxVideoChannelUsers: null,
      maxStageVideoChannelUsers: null,
      roles: new Map<string, GatewayGuildRole>(),
      channels: new Map<string, GatewayChannelSnapshot>(),
      selfRoleIds: null,
      voiceStatesByUserId: new Map<string, string | null>(),
    };

    snapshot.ownerId = guild.owner_id ?? snapshot.ownerId;
    snapshot.maxVideoChannelUsers = guild.max_video_channel_users ?? snapshot.maxVideoChannelUsers;
    snapshot.maxStageVideoChannelUsers =
      guild.max_stage_video_channel_users ?? snapshot.maxStageVideoChannelUsers;

    for (const role of guild.roles ?? []) {
      if (!role.id) continue;
      snapshot.roles.set(role.id, {
        id: role.id,
        permissions: parsePermissionBits(role.permissions),
      });
    }

    for (const channel of guild.channels ?? []) {
      const parsed = parseChannelSnapshot(channel, guild.id);
      if (parsed) snapshot.channels.set(parsed.id, parsed);
    }

    const currentUserId = this.currentUserRef?.id;
    if (currentUserId) {
      for (const member of guild.members ?? []) {
        if (member.user?.id !== currentUserId) continue;
        snapshot.selfRoleIds = member.roles ?? [];
      }
    }

    if (guild.voice_states) {
      snapshot.voiceStatesByUserId.clear();
      for (const voiceState of guild.voice_states) {
        if (!voiceState.user_id) continue;
        snapshot.voiceStatesByUserId.set(voiceState.user_id, voiceState.channel_id ?? null);
      }
    }

    this.guilds.set(guild.id, snapshot);
    this.events.emit('guild', guild.id);
  }

  private mergeChannel(data: unknown): void {
    const guildId = getStringField(data, 'guild_id');
    const channelId = getStringField(data, 'id');
    if (!guildId || !channelId) return;

    const guild = this.guilds.get(guildId) ?? {
      id: guildId,
      ownerId: null,
      maxVideoChannelUsers: null,
      maxStageVideoChannelUsers: null,
      roles: new Map<string, GatewayGuildRole>(),
      channels: new Map<string, GatewayChannelSnapshot>(),
      selfRoleIds: null,
      voiceStatesByUserId: new Map<string, string | null>(),
    };

    const parsed = parseChannelSnapshot(data, guildId);
    if (!parsed) return;

    guild.channels.set(channelId, parsed);
    this.guilds.set(guildId, guild);
    this.events.emit('guild', guildId);
  }

  private deleteChannel(data: unknown): void {
    const guildId = getStringField(data, 'guild_id');
    const channelId = getStringField(data, 'id');
    if (!guildId || !channelId) return;
    this.guilds.get(guildId)?.channels.delete(channelId);
  }

  private updateVoiceStateCache(data: unknown): void {
    const guildId = getStringField(data, 'guild_id');
    const userId = getStringField(data, 'user_id');
    if (!guildId || !userId) return;

    const guild = this.guilds.get(guildId) ?? {
      id: guildId,
      ownerId: null,
      maxVideoChannelUsers: null,
      maxStageVideoChannelUsers: null,
      roles: new Map<string, GatewayGuildRole>(),
      channels: new Map<string, GatewayChannelSnapshot>(),
      selfRoleIds: null,
      voiceStatesByUserId: new Map<string, string | null>(),
    };
    guild.voiceStatesByUserId.set(userId, getNullableStringField(data, 'channel_id'));
    this.guilds.set(guildId, guild);
  }

  private resolveChannelPermissions(
    guild: GatewayGuildSnapshotInternal,
    channel: GatewayChannelSnapshot
  ): { connect: boolean; stream: boolean } | null {
    const currentUserId = this.currentUserRef?.id;
    const roleIds = guild.selfRoleIds;
    if (!currentUserId || !roleIds) return null;

    if (guild.ownerId === currentUserId) {
      return { connect: true, stream: true };
    }

    let permissions = guild.roles.get(guild.id)?.permissions ?? 0n;
    for (const roleId of roleIds) {
      permissions |= guild.roles.get(roleId)?.permissions ?? 0n;
    }

    if ((permissions & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION) {
      permissions = ALL_PERMISSIONS;
    } else {
      const everyoneOverwrite = channel.permissionOverwrites.find(
        (overwrite) => overwrite.id === guild.id
      );
      if (everyoneOverwrite) {
        permissions &= ~everyoneOverwrite.deny;
        permissions |= everyoneOverwrite.allow;
      }

      let roleAllow = 0n;
      let roleDeny = 0n;
      for (const overwrite of channel.permissionOverwrites) {
        if (overwrite.type !== 0 || !roleIds.includes(overwrite.id)) continue;
        roleAllow |= overwrite.allow;
        roleDeny |= overwrite.deny;
      }
      permissions &= ~roleDeny;
      permissions |= roleAllow;

      const memberOverwrite = channel.permissionOverwrites.find(
        (overwrite) => overwrite.type === 1 && overwrite.id === currentUserId
      );
      if (memberOverwrite) {
        permissions &= ~memberOverwrite.deny;
        permissions |= memberOverwrite.allow;
      }
    }

    return {
      connect: (permissions & CONNECT_PERMISSION) === CONNECT_PERMISSION,
      stream: (permissions & STREAM_PERMISSION) === STREAM_PERMISSION,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function parseChannelSnapshot(data: unknown, guildId: string): GatewayChannelSnapshot | null {
  const channelId = getStringField(data, 'id');
  const type = getNumberField(data, 'type');
  if (!channelId || typeof type !== 'number') return null;

  const rawOverwrites = Array.isArray(
    (data as { permission_overwrites?: unknown[] }).permission_overwrites
  )
    ? ((data as { permission_overwrites?: unknown[] }).permission_overwrites ?? [])
    : [];

  return {
    id: channelId,
    guildId,
    type,
    name: getNullableStringField(data, 'name'),
    userLimit: getNullableNumberField(data, 'user_limit'),
    permissionOverwrites: rawOverwrites
      .map((overwrite) => parsePermissionOverwrite(overwrite))
      .filter((overwrite): overwrite is GatewayChannelOverwrite => overwrite !== null),
  };
}

function parsePermissionOverwrite(data: unknown): GatewayChannelOverwrite | null {
  const id = getStringField(data, 'id');
  if (!id) return null;

  const rawType = getNumberOrStringField(data, 'type');
  const type = typeof rawType === 'string' ? Number.parseInt(rawType, 10) : rawType;
  if (typeof type !== 'number') return null;

  return {
    id,
    type,
    allow: parsePermissionBits(getStringField(data, 'allow')),
    deny: parsePermissionBits(getStringField(data, 'deny')),
  };
}

function parsePermissionBits(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function countConnectedUsers(
  voiceStatesByUserId: Map<string, string | null>,
  channelId: string
): number {
  let total = 0;
  for (const activeChannelId of voiceStatesByUserId.values()) {
    if (activeChannelId === channelId) total += 1;
  }
  return total;
}

function getStringField(data: unknown, key: string): string | null {
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function getNullableStringField(data: unknown, key: string): string | null {
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function getNumberField(data: unknown, key: string): number | null {
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function getNullableNumberField(data: unknown, key: string): number | null {
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function getNumberOrStringField(data: unknown, key: string): number | string | null {
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function isSupportedGatewayEvent(eventType: string, data: unknown): boolean {
  switch (eventType) {
    case 'VOICE_STATE_UPDATE':
    case 'VOICE_SERVER_UPDATE':
    case 'STREAM_CREATE':
    case 'STREAM_SERVER_UPDATE':
    case 'STREAM_DELETE':
      return typeof data === 'object' && data !== null;
    default:
      return false;
  }
}

function classifyGatewayCloseCode(code: number): GatewayCloseClassification {
  if (code < 4_000) return 'resume';
  switch (code) {
    // 4000: Unknown error — reconnectable
    case 4_000:
    // 4001: Unknown opcode — reconnectable
    case 4_001:
    // 4002: Decode error — reconnectable
    case 4_002:
    // 4003: Not authenticated — reconnectable
    case 4_003:
    // 4005: Already authenticated — reconnectable
    case 4_005:
    // 4008: Rate limited — reconnectable
    case 4_008:
      return 'resume';
    // 4004: Authentication failed — invalid token
    case 4_004:
      return 'auth';
    // 4007: Invalid seq — must re-identify
    case 4_007:
    // 4009: Session timed out — must re-identify
    case 4_009:
      return 'identify';
    // 4010: Invalid shard
    // 4011: Sharding required
    // 4012: Invalid API version
    // 4013: Invalid intent(s)
    // 4014: Disallowed intent(s)
    default:
      return 'fatal';
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function platformName(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'Mac OS X';
    case 'win32':
      return 'Windows';
    default:
      return 'Linux';
  }
}

async function toTextPayload(data: string | ArrayBuffer | Blob): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(await data.arrayBuffer()).toString('utf8');
}
