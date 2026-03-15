import { Schema } from 'effect';

export const LogLevelSchema = Schema.Literal('debug', 'info', 'warn', 'error');

export type LogLevel = typeof LogLevelSchema.Type;

export class AppConfig extends Schema.Class<AppConfig>('AppConfig')({
  token: Schema.String,
  guildId: Schema.String,
  channelId: Schema.String,
  videoUrl: Schema.String,
  logLevel: Schema.optionalWith(LogLevelSchema, { default: () => 'info' as const }),
  ffmpegPath: Schema.optionalWith(Schema.String, { default: () => 'ffmpeg' }),
  ffprobePath: Schema.optionalWith(Schema.String, { default: () => 'ffprobe' }),
  stremioAddonUrl: Schema.optionalWith(Schema.String, { default: () => '' }),
  ytdlpPath: Schema.optionalWith(Schema.String, { default: () => 'yt-dlp' }),
  dlStreamsApiKey: Schema.optionalWith(Schema.String, { default: () => '' }),
  dlStreamsPlayerDomain: Schema.optionalWith(Schema.String, { default: () => '' }),
}) {}
