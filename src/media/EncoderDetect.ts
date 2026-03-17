import { spawn } from 'node:child_process';

export type HwEncoder = 'h264_nvmpi' | 'h264_v4l2m2m';
export type VideoEncoder = HwEncoder | 'libx264';

export interface EncoderCapabilities {
  available: VideoEncoder[];
  selected: VideoEncoder;
  ffmpegMajorVersion: number;
}

// Order matters: h264_nvmpi is Jetson-specific and reliable when installed.
// libx264 is preferred over h264_v4l2m2m because the V4L2 M2M encoder is
// often reported as available by FFmpeg but fails silently at runtime on
// many ARM boards (missing /dev/video* device, broken driver, etc.).
const KNOWN_ENCODERS: VideoEncoder[] = ['h264_nvmpi', 'libx264', 'h264_v4l2m2m'];

// Encoders that need a runtime probe (test-encode) before trusting them.
// libx264 is always reliable — no probe needed.
const NEEDS_PROBE: Set<VideoEncoder> = new Set(['h264_nvmpi', 'h264_v4l2m2m']);

export async function detectEncoder(
  ffmpegPath: string,
  preference: 'auto' | VideoEncoder
): Promise<EncoderCapabilities> {
  const [output, majorVersion] = await Promise.all([
    runFfmpegEncoders(ffmpegPath),
    detectFfmpegMajorVersion(ffmpegPath),
  ]);
  const listed = KNOWN_ENCODERS.filter((enc) => output.includes(enc));

  if (preference !== 'auto') {
    if (!listed.includes(preference)) {
      throw new Error(
        `Requested encoder '${preference}' is not available in ffmpeg. ` +
          `Available: ${listed.join(', ') || 'none (only libx264 as implicit fallback)'}`
      );
    }
    // Even explicit requests get a probe for HW encoders.
    if (NEEDS_PROBE.has(preference)) {
      const works = await probeEncoder(ffmpegPath, preference);
      if (!works) {
        throw new Error(
          `Requested encoder '${preference}' is listed by ffmpeg but failed ` +
            `a test encode. The hardware encoder device may not be accessible.`
        );
      }
    }
    return { available: listed, selected: preference, ffmpegMajorVersion: majorVersion };
  }

  // Auto-detect: try each encoder in priority order.  For HW encoders,
  // verify they actually work by test-encoding a single frame.
  for (const enc of KNOWN_ENCODERS) {
    if (!listed.includes(enc)) continue;

    if (!NEEDS_PROBE.has(enc)) {
      return { available: listed, selected: enc, ffmpegMajorVersion: majorVersion };
    }

    const works = await probeEncoder(ffmpegPath, enc);
    if (works) {
      return { available: listed, selected: enc, ffmpegMajorVersion: majorVersion };
    }
  }

  // libx264 should always be available, but guard anyway.
  return { available: listed, selected: 'libx264', ffmpegMajorVersion: majorVersion };
}

/**
 * Test-encode a single black frame to verify the encoder actually works at
 * runtime.  This catches hardware encoders that are listed in `ffmpeg
 * -encoders` but fail because the V4L2 device is missing, the driver is
 * broken, or permissions are wrong.
 *
 * Runs: ffmpeg -f lavfi -i color=black:s=64x64:d=0.04 -c:v <enc> -f null -
 * Timeout: 5 seconds.
 */
function probeEncoder(ffmpegPath: string, encoder: VideoEncoder): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'color=black:s=64x64:d=0.04:r=1',
        '-frames:v', '1',
        '-c:v', encoder,
        '-f', 'null',
        '-',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 5000);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });

    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function runFfmpegEncoders(ffmpegPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    child.once('exit', (code) => {
      if (code === 0 || code === null) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(new Error(`ffmpeg -encoders exited with code ${code}`));
      }
    });

    child.once('error', (err) => {
      reject(new Error(`Failed to run ffmpeg -encoders: ${err.message}`));
    });
  });
}

/**
 * Detect the FFmpeg major version by running `ffmpeg -version` and parsing the
 * first line (e.g. "ffmpeg version 5.1.6-0+deb12u1 ...").  Returns 0 if the
 * version cannot be determined (safe: callers treat 0 as "old FFmpeg").
 */
export function detectFfmpegMajorVersion(ffmpegPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    child.once('exit', () => {
      const output = Buffer.concat(chunks).toString('utf8');
      // Matches "ffmpeg version N.x.y" or "ffmpeg version n7.1-..."
      const match = /version\s+n?(\d+)/i.exec(output);
      resolve(match ? Number(match[1]) : 0);
    });

    child.once('error', () => {
      resolve(0);
    });
  });
}
