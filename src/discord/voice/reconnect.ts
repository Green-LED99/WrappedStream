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

  if (code === 4006 || code === 4009) {
    return 'refresh';
  }

  return 'fatal';
}
