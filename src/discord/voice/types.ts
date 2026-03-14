export type VoiceStreamDescriptor = {
  active: boolean;
  quality: number;
  rid: string;
  ssrc: number;
  rtx_ssrc: number;
  type: string;
};

export type VoiceCodecDescriptor =
  | {
      name: string;
      type: 'audio';
      priority: number;
      payload_type: number;
    }
  | {
      name: string;
      type: 'video';
      priority: number;
      payload_type: number;
      rtx_payload_type: number;
      encode: boolean;
      decode: boolean;
    };

export type VoiceHello = {
  heartbeat_interval: number;
};

export type VoiceReady = {
  ssrc: number;
  ip: string;
  port: number;
  modes: string[];
  experiments: string[];
  streams: VoiceStreamDescriptor[];
};

export type VoiceSelectProtocolAck = {
  audio_codec: string;
  video_codec: string;
  dave_protocol_version: number;
} & {
  media_session_id?: string;
  sdp?: string;
};

export type VoiceSpeaking = {
  speaking: 0 | 1 | 2;
  delay: number;
  ssrc: number;
};

export type VoiceClientsConnect = {
  user_ids: string[];
};

export type VoiceClientDisconnect = {
  user_id: string;
};

export type VoicePrepareTransition = {
  transition_id: number;
  protocol_version: number;
};

export type VoiceExecuteTransition = {
  transition_id: number;
};

export type VoicePrepareEpoch = {
  epoch: number;
  protocol_version: number;
};

export type VoiceGatewayResponse =
  | { op: 2; d: VoiceReady; seq?: number }
  | { op: 3; d: unknown; seq?: number }
  | { op: 4; d: VoiceSelectProtocolAck; seq?: number }
  | { op: 6; d: { t: number }; seq?: number }
  | { op: 8; d: VoiceHello; seq?: number }
  | { op: 9; d: null; seq?: number }
  | { op: 11; d: VoiceClientsConnect; seq?: number }
  | { op: 13; d: VoiceClientDisconnect; seq?: number }
  | { op: 21; d: VoicePrepareTransition; seq?: number }
  | { op: 22; d: VoiceExecuteTransition; seq?: number }
  | { op: 24; d: VoicePrepareEpoch; seq?: number };
