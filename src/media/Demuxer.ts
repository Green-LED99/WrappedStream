import { once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import type { Logger } from '../utils/logger.js';

export type VideoStreamInfo = {
  index: number;
  codec: 'H264';
  width: number;
  height: number;
  framerateNum: number;
  framerateDen: number;
  stream: Readable;
};

export type AudioStreamInfo = {
  index: number;
  codec: 'OPUS';
  sampleRate: number;
  stream: Readable;
};

type PacketLike = {
  streamIndex: number;
  data?: Uint8Array;
  pts?: bigint;
  duration?: bigint;
  timeBase: {
    num: number;
    den: number;
  };
  clone(): PacketLike;
  free(): void;
};

type VideoCodecParametersLike = {
  width?: number;
  height?: number;
  frameRate: { num: number; den: number };
};

type BitstreamFilterInputLike = {
  codecpar: unknown;
  timeBase: unknown;
};

type BitstreamFilterLike = {
  outputCodecParameters?: unknown;
  outputTimeBase?: unknown;
  filterAll(packet: PacketLike | null): Promise<(PacketLike | null)[]>;
  close(): void;
};

type BitstreamFilterFactoryLike = {
  create(
    name: string,
    stream: BitstreamFilterInputLike,
    options?: { options?: Record<string, string> }
  ): BitstreamFilterLike;
};

type BitstreamFilterDefinition = {
  name: string;
  options?: Record<string, string>;
};

function parseOpusPacketDuration(frame: Uint8Array): number {
  const firstByte = frame[0] ?? 0;
  const secondByte = frame[1] ?? 0;
  const frameSizes = [
    10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20,
    2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20,
  ];

  const frameSize = (48_000 / 1000) * (frameSizes[firstByte >> 3] ?? 20);
  const c = firstByte & 0b11;

  if (c === 0) {
    return frameSize;
  }

  if (c === 1 || c === 2) {
    return frameSize * 2;
  }

  return frameSize * (secondByte & 0b11_1111);
}

export type DemuxResult = {
  video: VideoStreamInfo;
  audio?: AudioStreamInfo;
  /** Resolves when the background packet-iteration loop finishes (naturally or via abort). */
  done: Promise<void>;
};

export async function demuxNutStream(
  input: NodeJS.ReadableStream,
  logger: Logger
): Promise<DemuxResult> {
  const imported = (await import('node-av')) as {
    Demuxer: {
      open(
        input: NodeJS.ReadableStream,
        options: {
          format: string;
          bufferSize: number;
          options: Record<string, string>;
        }
      ): Promise<{
        video(): {
          index: number;
          codecpar: {
            codecId: number;
            width?: number;
            height?: number;
            frameRate: { num: number; den: number };
          };
          timeBase: {
            num: number;
            den: number;
          };
        } | null;
        audio(): {
          index: number;
          codecpar: {
            codecId: number;
            sampleRate?: number;
          };
        } | null;
        packets(): AsyncIterator<PacketLike | null>;
        close(): void;
      }>;
    };
    BitStreamFilterAPI: {
      create(
        name: string,
        stream: unknown,
        options?: { options?: Record<string, string> }
      ): {
        outputCodecParameters?: {
          width?: number;
          height?: number;
          frameRate: { num: number; den: number };
        };
        filterAll(packet: PacketLike | null): Promise<(PacketLike | null)[]>;
        close(): void;
      };
    };
    avGetCodecName(codecId: number): string;
  };

  const demuxer = await imported.Demuxer.open(input, {
    format: 'nut',
    // 64 KB read buffer — reduces syscall frequency vs the default 8 KB.
    // On ARM (Jetson Nano / RPi), syscall overhead is proportionally
    // more expensive so larger reads amortise the cost.  64 KB halves
    // the syscall rate compared to 32 KB with negligible memory impact.
    bufferSize: 65_536,
    options: {
      fflags: 'nobuffer',
    },
  });

  const videoSource = demuxer.video();
  if (!videoSource) {
    demuxer.close();
    throw new Error('The transcoded stream did not contain video.');
  }

  const videoCodecName = imported
    .avGetCodecName(videoSource.codecpar.codecId)
    .toLowerCase();
  if (videoCodecName !== 'h264') {
    demuxer.close();
    throw new Error(`Only H264 video is supported (got ${videoCodecName}).`);
  }

  const audioSource = demuxer.audio();
  const audioCodecName = audioSource
    ? imported.avGetCodecName(audioSource.codecpar.codecId).toLowerCase()
    : undefined;
  if (audioSource && audioCodecName !== 'opus') {
    demuxer.close();
    throw new Error(`Only Opus audio is supported (got ${audioCodecName}).`);
  }

  const videoFilters = createChainedBitstreamFilters(
    imported.BitStreamFilterAPI,
    {
      codecpar: videoSource.codecpar,
      timeBase: videoSource.timeBase,
    },
    [
      { name: 'h264_mp4toannexb' },
      {
        name: 'h264_metadata',
        options: {
          aud: 'remove',
        },
      },
      { name: 'dump_extra' },
    ]
  );

  const filteredCodecParameters = (videoFilters.at(-1)?.outputCodecParameters ??
    videoSource.codecpar) as VideoCodecParametersLike;
  // Object-mode highWaterMark controls how many packets can queue before
  // back-pressure kicks in.  Video frames average ~30-50 KB each so 8
  // packets ≈ 240-400 KB per pipe — enough to absorb jitter while
  // keeping memory lower on constrained devices (Jetson Nano 8 GB).
  const videoPipe = new PassThrough({ objectMode: true, highWaterMark: 8 });
  const audioPipe = new PassThrough({ objectMode: true, highWaterMark: 8 });

  const packetIterator = demuxer.packets();

  const cleanup = (error?: Error): void => {
    for (const filter of videoFilters) {
      filter.close();
    }

    demuxer.close();
    if (error) {
      videoPipe.destroy(error);
      audioPipe.destroy(error);
      return;
    }

    videoPipe.end();
    audioPipe.end();
  };

  const done = (async () => {
    try {
      while (true) {
        const next = await packetIterator.next();
        if (next.done) {
          const flushedPackets = await applyBitstreamFilters(videoFilters, null);
          for (const packet of flushedPackets) {
            if (packet) {
              if (videoPipe.destroyed) break;
              if (!videoPipe.write(packet)) {
                if (videoPipe.destroyed) break;
                await once(videoPipe, 'drain');
              }
            }
          }

          cleanup();
          return;
        }

        const packet = next.value;
        if (packet == null) {
          logger.debug('Skipping null packet from the NUT demuxer');
          continue;
        }

        if (packet.streamIndex === videoSource.index) {
          if (videoPipe.destroyed) { packet.free(); break; }
          const filteredPackets = await applyBitstreamFilters(
            videoFilters,
            packet
          );
          for (const filteredPacket of filteredPackets) {
            if (filteredPacket) {
              if (videoPipe.destroyed) break;
              if (!videoPipe.write(filteredPacket)) {
                if (videoPipe.destroyed) break;
                await once(videoPipe, 'drain');
              }
            }
          }
          continue;
        }

        if (audioSource && packet.streamIndex === audioSource.index) {
          if (audioPipe.destroyed) { packet.free(); break; }
          if (!packet.duration && packet.data) {
            packet.duration = BigInt(parseOpusPacketDuration(packet.data));
          }
          if (!audioPipe.write(packet)) {
            if (audioPipe.destroyed) break;
            await once(audioPipe, 'drain');
          }
          continue;
        }

        packet.free();
      }
    } catch (error) {
      // When streams are destroyed during a seek/skip, write() and
      // once(pipe, 'drain') throw ERR_STREAM_DESTROYED.  This is
      // expected and not an error — just exit the loop cleanly.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.debug('Demuxer loop ended (stream destroyed)');
        cleanup();
        return;
      }
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error('NUT demux failed', { message });
      cleanup(error instanceof Error ? error : new Error(message));
    }
  })();

  const video: VideoStreamInfo = {
    index: videoSource.index,
    codec: 'H264',
    width: filteredCodecParameters.width || 0,
    height: filteredCodecParameters.height || 0,
    framerateNum: filteredCodecParameters.frameRate.num,
    framerateDen: filteredCodecParameters.frameRate.den,
    stream: videoPipe,
  };

  const audio = audioSource
    ? {
        index: audioSource.index,
        codec: 'OPUS' as const,
        sampleRate: audioSource.codecpar.sampleRate || 48_000,
        stream: audioPipe,
      }
    : undefined;

  return audio ? { video, audio, done } : { video, done };
}

export function createChainedBitstreamFilters(
  factory: BitstreamFilterFactoryLike,
  initialStream: BitstreamFilterInputLike,
  definitions: BitstreamFilterDefinition[]
): BitstreamFilterLike[] {
  let currentStream = initialStream;

  return definitions.map((definition) => {
    const filter = factory.create(
      definition.name,
      currentStream,
      definition.options ? { options: definition.options } : undefined
    );

    currentStream = {
      codecpar: filter.outputCodecParameters ?? currentStream.codecpar,
      timeBase: filter.outputTimeBase ?? currentStream.timeBase,
    };

    return filter;
  });
}

async function applyBitstreamFilters(
  filters: Pick<BitstreamFilterLike, 'filterAll'>[],
  input: PacketLike | null
): Promise<(PacketLike | null)[]> {
  let packets: (PacketLike | null)[] = [input];

  for (const filter of filters) {
    const nextPackets: (PacketLike | null)[] = [];

    for (const packet of packets) {
      const filtered = await filter.filterAll(packet);
      nextPackets.push(...filtered);
      packet?.free();
    }

    if (input === null) {
      nextPackets.push(null);
    }

    packets = nextPackets;
  }

  return packets;
}
