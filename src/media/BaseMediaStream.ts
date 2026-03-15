import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

type PacketLike = {
  data?: Uint8Array | Buffer;
  pts?: bigint;
  duration?: bigint;
  timeBase: {
    num: number;
    den: number;
  };
  free?: () => void;
};

export class BaseMediaStream extends Writable {
  private ptsValue?: number;
  private readonly syncTolerance = 20;
  private noSleepMode: boolean;
  private startTime?: number;
  private startPts?: number;
  private syncEnabled = true;
  private syncTarget: BaseMediaStream | undefined;

  public constructor(
    private readonly type: 'video' | 'audio',
    noSleep = false
  ) {
    super({ objectMode: true, highWaterMark: 0 });
    this.noSleepMode = noSleep;
  }

  public set sync(value: boolean) {
    this.syncEnabled = value;
  }

  public set syncStream(stream: BaseMediaStream | undefined) {
    this.syncTarget = stream;
  }

  public set noSleep(value: boolean) {
    this.noSleepMode = value;
  }

  public get pts(): number | undefined {
    return this.ptsValue;
  }

  protected async sendFrame(_frame: Uint8Array, _frameTimeMs: number): Promise<void> {
    throw new Error(`${this.type} sendFrame must be implemented by a subclass.`);
  }

  public override async _write(
    packet: PacketLike,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): Promise<void> {
    try {
      if (!packet.data) {
        packet.free?.();
        callback();
        return;
      }

      const frameTimeMs =
        (Number(packet.duration || 0n) / packet.timeBase.den) *
        packet.timeBase.num *
        1000;
      await this.sendFrame(packet.data, frameTimeMs);
      const endSend = performance.now();

      this.ptsValue =
        (Number(packet.pts || 0n) / packet.timeBase.den) *
        packet.timeBase.num *
        1000;
      this.emit('pts', this.ptsValue);

      this.startTime ??= endSend;
      this.startPts ??= this.ptsValue;

      const targetElapsedMs = this.ptsValue - this.startPts + frameTimeMs;
      const actualElapsedMs = endSend - this.startTime;
      const sleepDuration = Math.max(0, targetElapsedMs - actualElapsedMs);

      if (this.noSleepMode || sleepDuration === 0) {
        callback();
      } else if (this.syncEnabled && this.isAhead()) {
        await sleep(frameTimeMs);
        callback();
      } else {
        await sleep(sleepDuration);
        callback();
      }
    } catch (error) {
      callback(error as Error);
    } finally {
      packet.free?.();
    }
  }

  public override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.syncTarget = undefined;
    callback(error);
  }

  private ptsDelta(): number | undefined {
    if (this.ptsValue === undefined || this.syncTarget?.pts === undefined) {
      return undefined;
    }

    return this.ptsValue - this.syncTarget.pts;
  }

  private isAhead(): boolean {
    const delta = this.ptsDelta();
    return (
      this.syncTarget?.writableEnded === false &&
      delta !== undefined &&
      delta > this.syncTolerance
    );
  }
}
