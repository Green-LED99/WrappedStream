import { type ChildProcess, spawn } from 'node:child_process';
import type { TranscodePlan } from './TranscodePlan.js';

export type FfmpegNutProcess = {
  child: ChildProcess;
  output: NodeJS.ReadableStream;
  wait: Promise<void>;
  startedAt: number;
  stop(): void;
};

/**
 * Escape a file path / URL for use in the FFmpeg `subtitles` filter value.
 *
 * FFmpeg's filter option parser uses `:` as the option separator. When the
 * argument is passed directly via `spawn()` (no shell), each special character
 * must be preceded by **two** backslashes (`\\`) so that the filtergraph
 * parser un-escapes one level and the remaining `\:` is treated as a literal
 * colon by the subtitles filter itself.
 *
 * Special characters: `\` `:` `'` `[` `]` `;`
 *
 * The `:` before option keys like `:si=0` must NOT be escaped — those are
 * appended separately after the escaped filename.
 */
function escapeSubtitlePath(path: string): string {
  return path
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, "\\\\'")
    .replace(/\[/g, '\\\\[')
    .replace(/]/g, '\\\\]')
    .replace(/;/g, '\\\\;');
}

export function buildFfmpegNutArgs(
  url: string,
  plan: TranscodePlan,
  audioUrl?: string,
  httpHeaders?: Record<string, string>
): string[] {
  const args = ['-v', 'warning', '-extension_picky', '0'];

  if (httpHeaders && Object.keys(httpHeaders).length > 0) {
    const headerStr = Object.entries(httpHeaders)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    args.push('-headers', headerStr);
  }

  // Reconnect flags are only useful for direct HTTP streams (mp4, mkv).
  // For HLS (m3u8 / playlist URLs), the HLS demuxer handles segment
  // fetching internally — reconnect flags cause it to hang on EOF.
  const isHls = /\.m3u8?(\?|$)/i.test(url) || /\/playlist\b/i.test(url);
  if (!isHls) {
    args.push(
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_at_eof',
      '1',
    );
  }

  args.push('-i', url);

  // When a separate audio URL is provided (e.g. YouTube split streams),
  // add it as a second input.
  if (audioUrl) {
    args.push(
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_at_eof',
      '1',
      '-i',
      audioUrl
    );
  }

  args.push('-map', '0:v:0');

  if (plan.audio) {
    // If we have a separate audio input, map from input 1; otherwise from input 0.
    args.push('-map', audioUrl ? '1:a:0' : '0:a:0?');
  } else {
    args.push('-an');
  }

  args.push(
    '-threads:v',
    String(plan.video.threads),
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p'
  );

  // Build the video filter chain.
  // Order: scale first (work on smaller frames), then burn subtitles.
  const filters = [...plan.video.filters];

  if (plan.subtitle != null) {
    const escaped = escapeSubtitlePath(url);
    filters.push(`subtitles=${escaped}:si=${plan.subtitle.streamIndex}`);
  }

  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
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
  plan: TranscodePlan,
  audioUrl?: string,
  httpHeaders?: Record<string, string>
): FfmpegNutProcess {
  const args = buildFfmpegNutArgs(url, plan, audioUrl, httpHeaders);
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
