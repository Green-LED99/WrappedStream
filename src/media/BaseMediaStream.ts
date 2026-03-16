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

export interface PipelineStats {
  framesProcessed: number;
  lateFrames: number;
  maxLatenessMs: number;
  maxSendMs: number;
}

const STATS_INTERVAL = 300;

export class BaseMediaStream extends Writable {
  private ptsValue?: number;
  private readonly syncTolerance = 20;
  private noSleepMode: boolean;
  private startTime?: number;
  private startPts?: number;
  private syncEnabled = true;
  private syncTarget: BaseMediaStream | undefined;

  private statsData: PipelineStats = {
    framesProcessed: 0,
    lateFrames: 0,
    maxLatenessMs: 0,
    maxSendMs: 0,
  };

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

  public get stats(): Readonly<PipelineStats> {
    return { ...this.statsData };
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

      const sendStart = performance.now();
      await this.sendFrame(packet.data, frameTimeMs);
      const endSend = performance.now();
      const sendDuration = endSend - sendStart;

      // Update stats
      this.statsData.framesProcessed += 1;
      if (sendDuration > this.statsData.maxSendMs) {
        this.statsData.maxSendMs = sendDuration;
      }

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

      // Track late frames
      if (sleepDuration === 0 && actualElapsedMs > targetElapsedMs) {
        const lateness = actualElapsedMs - targetElapsedMs;
        this.statsData.lateFrames += 1;
        if (lateness > this.statsData.maxLatenessMs) {
          this.statsData.maxLatenessMs = lateness;
        }
      }

      // Emit stats periodically
      if (this.statsData.framesProcessed % STATS_INTERVAL === 0) {
        this.emit('stats', this.stats);
      }

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
