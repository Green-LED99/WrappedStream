export type ConnectionKind = 'voice' | 'stream';
export type ReconnectState = 'idle' | 'resuming' | 'refreshing' | 'failed';
export type RecoveryTrigger =
  | 'socket_close'
  | 'heartbeat_timeout'
  | 'voice_state_update'
  | 'stream_delete';
export type CloseClassification = 'resume' | 'refresh' | 'fatal';

export type ReconnectDiagnostics = {
  connectionKind: ConnectionKind;
  attempt: number;
  trigger: RecoveryTrigger;
  state: ReconnectState;
  closeCode?: number;
  closeReason?: string;
};

/**
 * Classify a voice gateway close code into a recovery strategy.
 * See https://discord.com/developers/docs/topics/opcodes-and-status-codes#voice-voice-close-event-codes
 */
export function classifyVoiceCloseCode(code: number): CloseClassification {
  if (code < 4000 || code === 4015) {
    return 'resume';
  }

  // 4006: Session no longer valid — need fresh connection
  // 4009: Session timeout — need fresh connection
  if (code === 4006 || code === 4009) {
    return 'refresh';
  }

  // Explicitly fatal codes include:
  // 4001: Unknown opcode
  // 4002: Failed to decode payload
  // 4003: Not authenticated
  // 4004: Authentication failed
  // 4005: Already authenticated
  // 4007: Invalid seq
  // 4011: Server not found
  // 4012: Unknown protocol
  // 4014: Disconnected
  // 4016: Unknown encryption mode
  // 4021: Channel was deleted
  return 'fatal';
}
