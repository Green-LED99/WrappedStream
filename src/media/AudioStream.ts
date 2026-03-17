import type { WebRtcConnection } from '../transport/WebRtcConnection.js';
import { BaseMediaStream, type ClockRef } from './BaseMediaStream.js';

export class AudioStream extends BaseMediaStream {
  public constructor(
    private readonly connection: WebRtcConnection,
    clockRef?: ClockRef,
  ) {
    super('audio', false, clockRef);
  }

  protected override async sendFrame(
    frame: Uint8Array,
    frameTimeMs: number
  ): Promise<void> {
    this.connection.sendAudioFrame(frame, frameTimeMs);
  }
}
