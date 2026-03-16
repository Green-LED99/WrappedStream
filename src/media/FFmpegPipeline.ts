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
  httpHeaders?: Record<string, string>,
  ffmpegMajorVersion?: number
): string[] {
  const args = ['-v', 'warning'];

  // ── Input analysis tuning ──────────────────────────────────────────
  // Reduce FFmpeg's initial analysis window to speed up stream startup.
  // Default is 5s / 5MB which is excessive for a known-good stream.
  args.push(
    '-analyzeduration', '2000000',  // 2 seconds (in microseconds)
    '-probesize', '1048576',        // 1 MB
  );

  // Minimize input buffering for lower latency on constrained devices.
  args.push('-fflags', 'nobuffer');

  // -extension_picky 0 is only needed for HLS streams that use non-standard
  // segment file extensions (e.g. .txt instead of .ts).  The flag was added
  // in FFmpeg 7.0 and does not exist in older versions (Debian Bookworm
  // ships FFmpeg 5.x).  Only include it when we know FFmpeg >= 7.
  const isHls = /\.m3u8?(\?|$)/i.test(url) || /\/playlist\b/i.test(url);
  if (isHls && (ffmpegMajorVersion ?? 0) >= 7) {
    args.push('-extension_picky', '0');
  }

  if (httpHeaders && Object.keys(httpHeaders).length > 0) {
    const headerStr = Object.entries(httpHeaders)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    args.push('-headers', headerStr);
  }

  // Reconnect flags are only useful for direct HTTP streams (mp4, mkv).
  // For HLS (m3u8 / playlist URLs), the HLS demuxer handles segment
  // fetching internally — reconnect flags cause it to hang on EOF.
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
    // When the audio plan specifies a stream index (language-selected), use the
    // absolute stream index so FFmpeg picks the correct track.
    if (audioUrl) {
      args.push('-map', '1:a:0');
    } else if (plan.audio.audioStreamIndex != null) {
      args.push('-map', `0:${plan.audio.audioStreamIndex}?`);
    } else {
      args.push('-map', '0:a:0?');
    }
  } else {
    args.push('-an');
  }

  // ── Video codec ──────────────────────────────────────────────────────
  if (plan.video.mode === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    const { encoder } = plan.video;
    args.push('-c:v', encoder);

    if (encoder === 'libx264') {
      args.push(
        '-preset', plan.video.preset ?? 'fast',
        '-tune', 'zerolatency',
      );
      args.push('-threads:v', String(plan.video.threads));
    } else if (encoder === 'h264_nvmpi') {
      // Jetson Nano hardware encoder tuning:
      // - num_capture_buffers: reduce from default 10 to 4 to cut pipeline
      //   latency (fewer queued frames) while keeping the HW block fed.
      // - profile baseline: disables B-frames at the encoder level for
      //   lower latency (complements the -bf 0 flag below).
      // - rc cbr: constant bitrate avoids look-ahead buffering.
      args.push(
        '-num_capture_buffers', '4',
        '-profile:v', 'baseline',
        '-rc', 'cbr',
      );
    } else if (encoder === 'h264_v4l2m2m') {
      // Raspberry Pi / V4L2 hardware encoder — limit output buffers to
      // reduce memory usage while keeping the pipeline fed.
      args.push('-num_output_buffers', '16');
    }

    // All encoders (SW and HW) need pixel format
    args.push('-pix_fmt', 'yuv420p');

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
      `${plan.video.maxBitrateKbps}k`,
      '-bf',
      '0',
      '-g', String(plan.video.targetFps),
    );
  }

  // ── Audio codec ──────────────────────────────────────────────────────
  if (!plan.audio) {
    args.push('-flush_packets', '1', '-f', 'nut', 'pipe:1');
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

  // Flush each packet immediately to the pipe — reduces muxing latency.
  args.push('-flush_packets', '1', '-f', 'nut', 'pipe:1');
  return args;
}

export function createFfmpegNutProcess(
  ffmpegPath: string,
  url: string,
  plan: TranscodePlan,
  audioUrl?: string,
  httpHeaders?: Record<string, string>,
  ffmpegMajorVersion?: number
): FfmpegNutProcess {
  const args = buildFfmpegNutArgs(url, plan, audioUrl, httpHeaders, ffmpegMajorVersion);
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
