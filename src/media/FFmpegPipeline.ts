import { type ChildProcess, spawn } from 'node:child_process';
import type { TranscodePlan } from './TranscodePlan.js';

export type FfmpegNutProcess = {
  child: ChildProcess;
  output: NodeJS.ReadableStream;
  wait: Promise<void>;
  startedAt: number;
  stop(): void;
};

export function buildFfmpegNutArgs(url: string, plan: TranscodePlan): string[] {
  const args = [
    '-v',
    'warning',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_at_eof',
    '1',
    '-i',
    url,
    '-map',
    '0:v:0',
  ];

  if (plan.audio) {
    args.push('-map', '0:a:0?');
  } else {
    args.push('-an');
  }

  if (plan.video.mode === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-threads:v',
      String(plan.video.threads),
      '-c:v',
      'libx264',
      '-preset',
      'superfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p'
    );

    if (plan.video.filters.length > 0) {
      args.push('-vf', plan.video.filters.join(','));
    }

    args.push(
      '-r',
      String(plan.video.targetFps),
      '-b:v',
      `${plan.video.targetBitrateKbps}k`,
      '-maxrate:v',
      `${plan.video.maxBitrateKbps}k`,
      '-bufsize:v',
      `${plan.video.targetBitrateKbps}k`,
      '-bf',
      '0',
      '-force_key_frames',
      'expr:gte(t,n_forced*1)'
    );
  }

  if (!plan.audio) {
    args.push('-f', 'nut', 'pipe:1');
    return args;
  }

  if (plan.audio.mode === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    args.push(
      '-c:a',
      'libopus',
      '-ac',
      String(plan.audio.targetChannels),
      '-ar',
      String(plan.audio.targetSampleRate),
      '-b:a',
      `${plan.audio.targetBitrateKbps}k`
    );
  }

  args.push('-f', 'nut', 'pipe:1');
  return args;
}

export function createFfmpegNutProcess(
  ffmpegPath: string,
  url: string,
  plan: TranscodePlan
): FfmpegNutProcess {
  const args = buildFfmpegNutArgs(url, plan);
  const startedAt = performance.now();
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk) => {
    stderr.push(Buffer.from(chunk));
  });

  const wait = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }

      reject(
        new Error(
          `ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString('utf8')}`
        )
      );
    });
    child.once('error', (error) => {
      reject(new Error(`Unable to start ffmpeg: ${error.message}`));
    });
  });

  return {
    child,
    output: child.stdout,
    wait,
    startedAt,
    stop(): void {
      child.kill('SIGTERM');
    },
  };
}
