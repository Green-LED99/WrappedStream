import { spawn } from 'node:child_process';

export type FfprobeStream = {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  index?: number;
  tags?: {
    language?: string;
    title?: string;
  };
};

export type FfprobeResult = {
  streams: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
  };
};

/** Subtitle codecs that FFmpeg's `subtitles` filter (libass) can burn in. */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'ass',
  'ssa',
  'webvtt',
  'mov_text',
  'srt',
  'text',
]);

/**
 * Find the index (among subtitle streams only) of the first English
 * text subtitle stream, if one exists.
 *
 * Returns `undefined` if no English text subtitle is found.
 */
export function findEnglishSubtitleIndex(
  streams: FfprobeStream[]
): number | undefined {
  const subtitleStreams = streams.filter(
    (s) => s.codec_type === 'subtitle'
  );

  for (let i = 0; i < subtitleStreams.length; i++) {
    const sub = subtitleStreams[i]!;
    const codec = sub.codec_name?.toLowerCase() ?? '';
    const lang = sub.tags?.language?.toLowerCase() ?? '';

    if (TEXT_SUBTITLE_CODECS.has(codec) && (lang === 'eng' || lang === 'en')) {
      return i;
    }
  }

  return undefined;
}

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
        'stream=index,codec_name,codec_type,width,height,avg_frame_rate,sample_rate,channels:stream_tags=language,title:format=format_name,duration',
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
