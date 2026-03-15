import { spawn } from 'node:child_process';

export type FfprobeStream = {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
};

export type FfprobeResult = {
  streams: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
  };
};

export async function probeMedia(
  ffprobePath: string,
  url: string
): Promise<FfprobeResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,codec_type,width,height,avg_frame_rate,sample_rate,channels:format=format_name,duration',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        url,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    child.stdout.on('data', (chunk) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.from(chunk));
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `ffprobe exited with code ${code}: ${Buffer.concat(stderr).toString('utf8')}`
        )
      );
    });
    child.once('error', (error) => {
      reject(new Error(`Unable to start ffprobe: ${error.message}`));
    });
  });

  return JSON.parse(Buffer.concat(stdout).toString('utf8')) as FfprobeResult;
}
