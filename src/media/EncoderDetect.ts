import { spawn } from 'node:child_process';

export type HwEncoder = 'h264_nvmpi' | 'h264_v4l2m2m';
export type VideoEncoder = HwEncoder | 'libx264';

export interface EncoderCapabilities {
  available: VideoEncoder[];
  selected: VideoEncoder;
}

const KNOWN_ENCODERS: VideoEncoder[] = ['h264_nvmpi', 'h264_v4l2m2m', 'libx264'];

export async function detectEncoder(
  ffmpegPath: string,
  preference: 'auto' | VideoEncoder
): Promise<EncoderCapabilities> {
  const output = await runFfmpegEncoders(ffmpegPath);
  const available = KNOWN_ENCODERS.filter((enc) => output.includes(enc));

  if (preference !== 'auto') {
    if (!available.includes(preference)) {
      throw new Error(
        `Requested encoder '${preference}' is not available in ffmpeg. ` +
          `Available: ${available.join(', ') || 'none (only libx264 as implicit fallback)'}`
      );
    }
    return { available, selected: preference };
  }

  // Auto-detect: prefer HW encoders in order
  for (const enc of KNOWN_ENCODERS) {
    if (available.includes(enc)) {
      return { available, selected: enc };
    }
  }

  // libx264 should always be available, but guard anyway
  return { available, selected: 'libx264' };
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
