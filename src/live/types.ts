export type SportsurgeEvent = {
  url: string;
  title: string;
  sport: string;
};

export type ResolvedLiveStream = {
  eventTitle: string;
  sport: string;
  streamUrl: string;
  headers: Record<string, string>;
};
