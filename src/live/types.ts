/**
 * DLStreams (DaddyLive) type definitions for schedule lookup and stream resolution.
 */

// ---------------------------------------------------------------------------
// DLStreams API responses
// ---------------------------------------------------------------------------

/** A channel entry within a scheduled event. */
export type DlStreamsEventChannel = {
  channel_name: string;
  channel_id: number;
};

/** A single scheduled event from the DLStreams schedule endpoint. */
export type DlStreamsEvent = {
  title: string;
  /** Channels broadcasting this event. */
  channels: DlStreamsEventChannel[];
  time?: string;
};

/** Full schedule response from the DLStreams API. */
export type DlStreamsScheduleResponse = {
  success: boolean;
  /** Nested: { [day]: { [category]: DlStreamsEvent[] } } */
  data: Record<string, Record<string, DlStreamsEvent[]>>;
  count: number;
  days_count: number;
};

// ---------------------------------------------------------------------------
// Search & resolution types
// ---------------------------------------------------------------------------

/** Input for the fuzzy event search. */
export type LiveSearchQuery = {
  query: string;
  /** Optional: direct channel ID bypass (skips schedule search). */
  channelId?: number | undefined;
};

/** A matched event with its best channel, ready for stream resolution. */
export type MatchedEvent = {
  title: string;
  channelName: string;
  channelId: number;
  day: string;
  category: string;
  score: number;
};

/**
 * A parsed event from the free schedule-api.php endpoint.
 *
 * The free endpoint returns HTML with data attributes instead of structured
 * JSON. Each event maps to a watch page URL (e.g. /watchpulsematch.php?id=20567)
 * rather than a direct DaddyLive channel ID.
 */
export type FreeScheduleEvent = {
  /** Event title (e.g. "PREMIER LEAGUE : Crystal Palace - Leeds United"). */
  title: string;
  /** Broadcast time (e.g. "10:00"). */
  time: string;
  /** Channel/category label (e.g. "premier league stream"). */
  channelLabel: string;
  /** Relative watch page URL (e.g. "/watchpulsematch.php?id=20567"). */
  watchUrl: string;
  /** Fuzzy match score (populated by matchFreeEvent). */
  score: number;
};

/** Final resolved live stream ready for the FFmpeg pipeline. */
export type ResolvedLiveStream = {
  eventTitle: string;
  channelName: string;
  channelId: number;
  streamUrl: string;
  /** Required HTTP headers for the HLS stream (Referer, Origin). */
  headers: Record<string, string>;
};
