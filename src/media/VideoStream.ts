import type { WebRtcConnection } from '../transport/WebRtcConnection.js';
import { BaseMediaStream } from './BaseMediaStream.js';

export class VideoStream extends BaseMediaStream {
  public constructor(private readonly connection: WebRtcConnection) {
    super('video');
  }

  protected override async sendFrame(
    frame: Uint8Array,
    frameTimeMs: number
  ): Promise<void> {
    this.connection.sendVideoFrame(frame, frameTimeMs);
  }
}
