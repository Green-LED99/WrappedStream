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

/** Common ISO 639-2/B ↔ ISO 639-1 mappings for cross-format matching. */
const ISO_639_MAP: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', spa: 'es', ger: 'de', deu: 'de',
  ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko', zho: 'zh',
  chi: 'zh', ara: 'ar', hin: 'hi', tur: 'tr', pol: 'pl', nld: 'nl',
  dut: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
};

/** Matches a stream's language tag against a target language code. */
function matchesLanguage(streamLang: string, targetLang: string): boolean {
  const s = streamLang.toLowerCase();
  const t = targetLang.toLowerCase();
  if (s === t) return true;
  if (ISO_639_MAP[t] === s) return true;
  if (ISO_639_MAP[s] === t) return true;
  return false;
}

/**
 * Find the index (among subtitle streams only) of the first text
 * subtitle stream matching the given language.
 *
 * Returns `undefined` if no matching text subtitle is found.
 */
export function findSubtitleIndex(
  streams: FfprobeStream[],
  language: string
): number | undefined {
  const subtitleStreams = streams.filter(
    (s) => s.codec_type === 'subtitle'
  );

  for (let i = 0; i < subtitleStreams.length; i++) {
    const sub = subtitleStreams[i]!;
    const codec = sub.codec_name?.toLowerCase() ?? '';
    const lang = sub.tags?.language?.toLowerCase() ?? '';

    if (TEXT_SUBTITLE_CODECS.has(codec) && matchesLanguage(lang, language)) {
      return i;
    }
  }

  return undefined;
}

/**
 * Find the first English text subtitle stream index.
 * @deprecated Use `findSubtitleIndex(streams, language)` instead.
 */
export function findEnglishSubtitleIndex(
  streams: FfprobeStream[]
): number | undefined {
  return findSubtitleIndex(streams, 'eng');
}

/**
 * Find the first audio stream matching the given language.
 * Returns `undefined` if no matching audio stream is found.
 */
export function findAudioStreamByLanguage(
  streams: FfprobeStream[],
  language: string
): FfprobeStream | undefined {
  return streams.find(
    (s) =>
      s.codec_type === 'audio' &&
      s.tags?.language != null &&
      matchesLanguage(s.tags.language, language)
  );
}

export async function probeMedia(
  ffprobePath: string,
  url: string,
  httpHeaders?: Record<string, string>
): Promise<FfprobeResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const args = ['-v', 'error'];

    // -extension_picky 0 is only needed for HLS streams with non-standard
    // segment extensions (.txt).  Added in FFmpeg 7.0 — older versions
    // (e.g. Debian Bookworm's FFmpeg 5.x) do not recognise it.
    const isHls = /\.m3u8?(\?|$)/i.test(url) || /\/playlist\b/i.test(url);
    if (isHls) {
      args.push('-extension_picky', '0');
    }

    if (httpHeaders && Object.keys(httpHeaders).length > 0) {
      const headerStr = Object.entries(httpHeaders)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      args.push('-headers', headerStr);
    }

    args.push(
      '-show_entries',
      'stream=index,codec_name,codec_type,width,height,avg_frame_rate,sample_rate,channels:stream_tags=language,title:format=format_name,duration',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      url,
    );

    const child = spawn(ffprobePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
