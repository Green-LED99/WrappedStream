/** Discord Gateway opcodes — https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-opcodes */
export enum GatewayOpcode {
  /** Receive: An event was dispatched */
  Dispatch = 0,
  /** Send/Receive: Fired periodically to keep the connection alive */
  Heartbeat = 1,
  /** Send: Starts a new session during the initial handshake */
  Identify = 2,
  /** Send: Update the client's presence */
  PresenceUpdate = 3,
  /** Send: Used to join/leave or move between voice channels */
  VoiceStateUpdate = 4,
  /** Send: Voice server ping */
  VoiceServerPing = 5,
  /** Send: Resume a previous session that was disconnected */
  Resume = 6,
  /** Receive: You should attempt to reconnect and resume immediately */
  Reconnect = 7,
  /** Send: Request guild members */
  RequestGuildMembers = 8,
  /** Receive: The session has been invalidated */
  InvalidSession = 9,
  /** Receive: Sent immediately after connecting, contains heartbeat_interval */
  Hello = 10,
  /** Receive: Acknowledgement of a heartbeat */
  HeartbeatAck = 11,
  /** Send: Request to create a Go Live stream */
  StreamCreate = 18,
  /** Send: Request to delete a Go Live stream */
  StreamDelete = 19,
  /** Send: Watch a Go Live stream */
  StreamWatch = 20,
  /** Send: Ping a Go Live stream */
  StreamPing = 21,
  /** Send: Set stream paused state */
  StreamSetPaused = 22,
}
