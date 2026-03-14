export type GatewayEventGeneric<Type extends string, Data> = {
  t: Type;
  d: Data;
};

export type GatewayVoiceStateUpdate = GatewayEventGeneric<
  'VOICE_STATE_UPDATE',
  {
    guild_id?: string | null;
    channel_id?: string | null;
    user_id: string;
    session_id: string;
  }
>;

export type GatewayVoiceServerUpdate = GatewayEventGeneric<
  'VOICE_SERVER_UPDATE',
  {
    guild_id?: string | null;
    channel_id?: string | null;
    endpoint: string | null;
    token: string;
  }
>;

export type GatewayStreamCreate = GatewayEventGeneric<
  'STREAM_CREATE',
  {
    stream_key: string;
    rtc_server_id: string;
    rtc_channel_id: string;
    region?: string;
    viewer_ids?: string[];
    paused?: boolean;
  }
>;

export type GatewayStreamServerUpdate = GatewayEventGeneric<
  'STREAM_SERVER_UPDATE',
  {
    stream_key: string;
    endpoint: string | null;
    token: string;
  }
>;

export type GatewayStreamDelete = GatewayEventGeneric<
  'STREAM_DELETE',
  {
    stream_key: string;
    reason: string;
    unavailable?: boolean;
  }
>;

export type GatewayEvent =
  | GatewayVoiceStateUpdate
  | GatewayVoiceServerUpdate
  | GatewayStreamCreate
  | GatewayStreamServerUpdate
  | GatewayStreamDelete;

export type RawGatewayListener = (event: GatewayEvent) => void;

export type GatewayUser = {
  id: string;
  bot?: boolean;
  username?: string;
};
