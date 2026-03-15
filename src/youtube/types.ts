/**
 * YouTube / yt-dlp type definitions for search and stream resolution.
 */

/**
 * Subset of yt-dlp `--dump-json` output we actually use.
 *
 * The full schema has hundreds of fields; we pick only what's needed
 * for resolving a streamable URL.
 */
export type YtdlpRequestedFormat = {
  url: string;
  vcodec?: string;
  acodec?: string;
  format_id?: string;
  protocol?: string;
};

export type YtdlpVideoInfo = {
  id: string;
  title: string;
  webpage_url: string;
  duration: number;
  /** Direct URL — present when a single combined format is selected. */
  url: string | null;
  channel?: string;
  uploader?: string;
  format?: string;
  format_id?: string;
  /**
   * When yt-dlp selects separate video+audio streams (e.g. `bv+ba`),
   * they appear here instead of in `url`.
   */
  requested_formats?: YtdlpRequestedFormat[];
};

/**
 * A resolved YouTube video ready for the streaming pipeline.
 *
 * Analogous to `ResolvedStream` from the Stremio integration.
 */
export type ResolvedYouTubeVideo = {
  videoId: string;
  title: string;
  webpageUrl: string;
  durationSeconds: number;
  /** Direct video URL (or combined video+audio URL). */
  streamUrl: string;
  /**
   * Separate audio URL when yt-dlp selected split video+audio streams.
   * When present, `streamUrl` is video-only and FFmpeg must merge them.
   */
  audioUrl?: string | undefined;
  channel?: string | undefined;
};
