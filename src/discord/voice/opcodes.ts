/** Discord Voice Gateway opcodes — https://discord.com/developers/docs/topics/opcodes-and-status-codes#voice */
export enum VoiceOpcode {
  /** Send: Begin a voice websocket connection */
  Identify = 0,
  /** Send: Select the voice protocol */
  SelectProtocol = 1,
  /** Receive: Complete the websocket handshake */
  Ready = 2,
  /** Send/Receive: Keep the websocket connection alive */
  Heartbeat = 3,
  /** Receive: Acknowledge SelectProtocol, includes SDP answer */
  SelectProtocolAck = 4,
  /** Send/Receive: Indicate which users are speaking */
  Speaking = 5,
  /** Receive: Heartbeat acknowledged */
  HeartbeatAck = 6,
  /** Send: Resume a connection */
  Resume = 7,
  /** Receive: Time to wait between sending heartbeats */
  Hello = 8,
  /** Receive: Acknowledge a resumed connection */
  Resumed = 9,
  /** Receive: Users connected to the voice channel */
  ClientsConnect = 11,
  /** Send: Video stream descriptor update */
  Video = 12,
  /** Receive: A user disconnected from voice */
  ClientDisconnect = 13,
  /** Receive: DAVE — prepare protocol version transition */
  DavePrepareTransition = 21,
  /** Receive: DAVE — execute protocol version transition */
  DaveExecuteTransition = 22,
  /** Send: DAVE — notify readiness for transition */
  DaveTransitionReady = 23,
  /** Receive: DAVE — prepare new MLS epoch */
  DavePrepareEpoch = 24,
  /** Receive: DAVE — invalid commit/welcome marker */
  MlsInvalidCommitWelcome = 31,
}

/** Binary voice opcodes — sent/received as raw binary frames */
export enum VoiceBinaryOpcode {
  /** Receive: MLS external sender key package */
  MlsExternalSender = 25,
  /** Send: Our MLS key package */
  MlsKeyPackage = 26,
  /** Receive: MLS proposals for roster changes */
  MlsProposals = 27,
  /** Send: MLS commit + welcome message */
  MlsCommitWelcome = 28,
  /** Receive: Announce commit transition */
  MlsAnnounceCommitTransition = 29,
  /** Receive: MLS welcome message */
  MlsWelcome = 30,
}
