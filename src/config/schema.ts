import { Schema } from 'effect';

export const LogLevelSchema = Schema.Literal('debug', 'info', 'warn', 'error');

export type LogLevel = typeof LogLevelSchema.Type;

export const VideoEncoderSchema = Schema.Literal('auto', 'h264_nvmpi', 'h264_v4l2m2m', 'libx264');
export type VideoEncoderOption = typeof VideoEncoderSchema.Type;

export const SubtitleBurnInSchema = Schema.Literal('auto', 'never');
export type SubtitleBurnIn = typeof SubtitleBurnInSchema.Type;

export const PerformanceProfileSchema = Schema.Literal('default', 'low-power');
export type PerformanceProfile = typeof PerformanceProfileSchema.Type;

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
  videoEncoder: Schema.optionalWith(VideoEncoderSchema, { default: () => 'auto' as const }),
  subtitleBurnIn: Schema.optionalWith(SubtitleBurnInSchema, { default: () => 'auto' as const }),
  performanceProfile: Schema.optionalWith(PerformanceProfileSchema, { default: () => 'default' as const }),
}) {}
