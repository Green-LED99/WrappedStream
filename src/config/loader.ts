import { config as loadDotenv } from 'dotenv';
import { Context, Effect, Layer, Schema } from 'effect';
import { ConfigError } from '../errors/index.js';
import { AppConfig } from './schema.js';

export class ConfigService extends Context.Tag('ConfigService')<
  ConfigService,
  AppConfig
>() {}

const decode = Schema.decodeUnknown(AppConfig);

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    loadDotenv();

    const raw = {
      token: process.env['DISCORD_TOKEN'],
      guildId: process.env['DISCORD_GUILD_ID'],
      channelId: process.env['DISCORD_CHANNEL_ID'],
      videoUrl: process.env['VIDEO_URL'],
      logLevel: process.env['LOG_LEVEL'],
      ffmpegPath: process.env['FFMPEG_PATH'],
      ffprobePath: process.env['FFPROBE_PATH'],
    };

    const config = yield* decode(raw).pipe(
      Effect.mapError(
        (parseError) =>
          new ConfigError({
            message: 'Invalid configuration',
            details: { error: String(parseError) },
          })
      )
    );

    return config;
  })
);
