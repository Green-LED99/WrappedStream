import { type ChildProcess, spawn } from 'node:child_process';
import type { TranscodePlan } from './TranscodePlan.js';

export type FfmpegNutProcess = {
  child: ChildProcess;
  output: NodeJS.ReadableStream;
  wait: Promise<void>;
  startedAt: number;
  stop(): Promise<void>;
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
  ffmpegMajorVersion?: number,
  seekSeconds?: number,
  audioStreamIndex?: number
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
  // genpts generates missing PTS values for robust timing on HLS/live sources.
  args.push('-fflags', 'nobuffer+genpts');

  // Global low-delay flags to minimize pipeline latency.
  args.push('-flags', 'low_delay');

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

  // Fast seek: place -ss before -i so FFmpeg seeks by keyframe in the
  // demuxer rather than decoding from the start.  This is critical for
  // large files and network streams.
  if (seekSeconds != null && seekSeconds > 0) {
    args.push('-ss', String(seekSeconds));
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
    // The CLI --audio-stream option overrides the plan's stream index.
    const effectiveAudioIdx = audioStreamIndex ?? plan.audio.audioStreamIndex;
    if (audioUrl) {
      args.push('-map', `1:a:${audioStreamIndex ?? 0}`);
    } else if (effectiveAudioIdx != null) {
      args.push('-map', `0:${effectiveAudioIdx}?`);
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
        // Match Discord's profile-level-id=42e01f (Constrained Baseline Level 3.1).
        '-profile:v', 'baseline',
        '-level:v', '3.1',
      );
      args.push('-threads:v', String(plan.video.threads));
      // Reduce reference frames to 1 for lower memory and faster encoding.
      // Combined with -bf 0 this means the encoder holds only 2 frames.
      args.push('-refs', '1');
      // Use slice threading for lower single-frame latency on ARM.
      args.push('-x264-params', 'sliced-threads=1');
    } else if (encoder === 'h264_nvmpi') {
      // Jetson Nano hardware encoder tuning:
      // - num_capture_buffers 6: balanced between pipeline feeding and
      //   latency (default 10 is too high, 4 risks starvation under load).
      // - profile baseline: disables B-frames for RTP compatibility.
      // - level 3.1: matches Discord's profile-level-id=42e01f (Constrained
      //   Baseline Level 3.1).
      // - rc cbr: constant bitrate avoids look-ahead buffering.
      args.push(
        '-num_capture_buffers', '6',
        '-profile:v', 'baseline',
        '-level:v', '3.1',
        '-rc', 'cbr',
      );
    } else if (encoder === 'h264_v4l2m2m') {
      // Raspberry Pi / V4L2 hardware encoder — default settings are
      // sufficient (num_output_buffers defaults to 16).
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
      // 1:1 bufsize:target ratio ensures tight CBR for real-time RTP
      // streaming.  A larger bufsize allows quality spikes that can
      // overwhelm the receiver's jitter buffer.
      '-bufsize:v',
      `${plan.video.targetBitrateKbps}k`,
      '-bf',
      '0',
      '-g', String(plan.video.targetFps),
      // Disable scene-change keyframes for predictable GOP structure in RTP.
      '-sc_threshold', '0',
    );
  }

  // ── Audio codec ──────────────────────────────────────────────────────
  if (!plan.audio) {
    args.push(
      '-max_delay', '0',
      '-flush_packets', '1',
      '-f_strict', 'experimental',
      '-f', 'nut',
      '-syncpoints', 'none',
      '-write_index', '0',
      'pipe:1',
    );
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
      `${plan.audio.targetBitrateKbps}k`,
      // Opus tuning for real-time media streaming to Discord:
      // - application audio: full-bandwidth mode optimised for music/general
      //   audio rather than speech (voip) or low-delay modes.
      // - vbr off: true CBR for consistent network behaviour and SRTP safety.
      // - compression_level 5: balanced quality/CPU on ARM Cortex-A57.
      // - frame_duration 20: explicit 20ms frames matching Discord's playback.
      '-application', 'audio',
      '-vbr', 'off',
      '-compression_level', '5',
      '-frame_duration', '20',
    );
  }

  // NUT muxer settings optimised for non-seekable pipe output:
  // - flush_packets 1: flush each packet immediately for minimal latency.
  // - syncpoints none: disables syncpoint overhead (stream is pipe, no seeking).
  // - write_index 0: disables growing data tables for endless streaming.
  // - max_delay 0 / muxdelay 0: eliminates muxer buffering.
  args.push(
    '-max_delay', '0',
    '-flush_packets', '1',
    '-f_strict', 'experimental',
    '-f', 'nut',
    '-syncpoints', 'none',
    '-write_index', '0',
    'pipe:1',
  );
  return args;
}

export function createFfmpegNutProcess(
  ffmpegPath: string,
  url: string,
  plan: TranscodePlan,
  audioUrl?: string,
  httpHeaders?: Record<string, string>,
  ffmpegMajorVersion?: number,
  seekSeconds?: number,
  audioStreamIndex?: number
): FfmpegNutProcess {
  const args = buildFfmpegNutArgs(url, plan, audioUrl, httpHeaders, ffmpegMajorVersion, seekSeconds, audioStreamIndex);
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
    async stop(): Promise<void> {
      if (child.killed || child.exitCode !== null) return;
      return new Promise<void>((resolve) => {
        const forceKill = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(forceKill);
          resolve();
        });
        child.kill('SIGTERM');
      });
    },
  };
}
