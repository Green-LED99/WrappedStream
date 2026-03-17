/**
 * Stremio addon protocol types for Cinemeta search + Torrentio stream resolution.
 */

// ---------------------------------------------------------------------------
// Cinemeta catalog search
// ---------------------------------------------------------------------------

export type CinemetaSearchResult = {
  metas: CinemetaMeta[];
};

export type CinemetaMeta = {
  id: string;
  imdb_id: string;
  type: 'movie' | 'series';
  name: string;
  year?: string;
  releaseInfo?: string;
  poster?: string;
  description?: string;
  imdbRating?: string;
  genres?: string[];
  runtime?: string;
};

// ---------------------------------------------------------------------------
// Torrentio stream response
// ---------------------------------------------------------------------------

export type TorrentioStreamResponse = {
  streams: TorrentioStream[];
};

export type TorrentioStream = {
  name: string;
  title: string;
  url: string;
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
  };
};

// ---------------------------------------------------------------------------
// Content type helpers
// ---------------------------------------------------------------------------

export type ContentType = 'movie' | 'series';

export type SearchQuery = {
  query: string;
  type?: ContentType | undefined;
  season?: number | undefined;
  episode?: number | undefined;
};

export type ResolvedStream = {
  imdbId: string;
  contentName: string;
  contentType: ContentType;
  streamTitle: string;
  streamUrl: string;
  filename?: string | undefined;
  quality?: string | undefined;
  /** Series episode context for auto-play-next. */
  season?: number | undefined;
  episode?: number | undefined;
  addonBase?: string | undefined;
};

// ---------------------------------------------------------------------------
// Cinemeta meta detail (for series episode listing)
// ---------------------------------------------------------------------------

export type CinemetaMetaDetail = {
  meta: {
    id: string;
    imdb_id: string;
    type: ContentType;
    name: string;
    videos?: CinemetaVideo[];
  };
};

export type CinemetaVideo = {
  id: string;
  season: number;
  episode: number;
  name?: string;
  released?: string;
};
