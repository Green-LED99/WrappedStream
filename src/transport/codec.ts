/** Codec payload type constants for Discord voice. */
export const codecPayloadType = {
  opus: {
    name: 'opus',
    type: 'audio',
    clockRate: 48_000,
    priority: 1_000,
    payload_type: 120,
  },
  H264: {
    name: 'H264',
    type: 'video',
    clockRate: 90_000,
    priority: 1_000,
    payload_type: 101,
    rtx_payload_type: 102,
    encode: true,
    decode: true,
  },
} as const;
