import 'dotenv/config';
import { Effect, Layer, pipe } from 'effect';
import { Command } from 'commander';
import { ConfigService, ConfigServiceLive } from './config/loader.js';
import { DaveService, DaveServiceLive } from './discord/dave/DaveService.js';
import { GatewayService, makeGatewayServiceLive } from './discord/gateway/GatewayService.js';
import { StreamerService, StreamerServiceLive } from './discord/streamer/StreamerService.js';
import { MediaService, MediaServiceLive } from './media/MediaService.js';
import { describeTranscodePlan } from './media/TranscodePlan.js';
import { resolveSearchQuery } from './stremio/StremioResolver.js';
import { resolveYouTubeQuery } from './youtube/YouTubeResolver.js';
import { resolveLiveQuery } from './live/LiveResolver.js';
import { createLogger } from './utils/logger.js';
import { PlaybackStateManager } from './discord/PlaybackState.js';
import { CommandServer } from './discord/CommandServer.js';

const program = new Command()
  .name('discord-stream')
  .description('Stream video to a Discord voice channel via Go Live')
  .version('0.1.0');

// ─── play-url ────────────────────────────────────────────────────────
program
  .command('play-url')
  .description('Stream a video URL to a Discord voice channel')
  .requiredOption('--guild-id <id>', 'Discord guild (server) ID')
  .requiredOption('--channel-id <id>', 'Discord voice channel ID')
  .requiredOption('--url <url>', 'Direct video URL (mp4/mkv)')
  .option('--seek <seconds>', 'Seek to this position in seconds', (v) => parseInt(v, 10), 0)
  .option('--audio-stream <index>', 'Audio stream index (0-based)', (v) => parseInt(v, 10))
  .option('--json', 'Output structured JSON logs', false)
  .action(async (options: {
    guildId: string;
    channelId: string;
    url: string;
    seek: number;
    audioStream?: number;
    json: boolean;
  }) => {
    await withSignalHandler((signal) =>
      runStreamJob({
        guildId: options.guildId,
        channelId: options.channelId,
        videoUrl: options.url,
        abortSignal: signal,
        seekSeconds: options.seek,
        audioStreamIndex: options.audioStream,
      })
    );
  });

// ─── play-url-with-commands ──────────────────────────────────────────
program
  .command('play-url-with-commands')
  .description('Stream a video URL with Discord slash command controls (/skip-forward, /skip-backward, /seek, /playtime)')
  .requiredOption('--guild-id <id>', 'Discord guild (server) ID')
  .requiredOption('--channel-id <id>', 'Discord voice channel ID')
  .requiredOption('--url <url>', 'Direct video URL (mp4/mkv)')
  .requiredOption('--bot-token <token>', 'Discord bot token for slash commands')
  .option('--seek <seconds>', 'Seek to this position in seconds', (v) => parseInt(v, 10), 0)
  .option('--audio-stream <index>', 'Audio stream index (0-based)', (v) => parseInt(v, 10))
  .option('--json', 'Output structured JSON logs', false)
  .action(async (options: {
    guildId: string;
    channelId: string;
    url: string;
    botToken: string;
    seek: number;
    audioStream?: number;
    json: boolean;
  }) => {
    await withSignalHandler((signal) =>
      runStreamJobWithCommands({
        guildId: options.guildId,
        channelId: options.channelId,
        videoUrl: options.url,
        botToken: options.botToken,
        abortSignal: signal,
        seekSeconds: options.seek,
        audioStreamIndex: options.audioStream,
      })
    );
  });

// ─── play-search ─────────────────────────────────────────────────────
program
  .command('play-search')
  .description(
    'Search for content via Stremio/Torrentio, resolve a Real-Debrid link, and stream it'
  )
  .requiredOption('--guild-id <id>', 'Discord guild (server) ID')
  .requiredOption('--channel-id <id>', 'Discord voice channel ID')
  .requiredOption('--query <query>', 'Search query (e.g. "The Dark Knight")')
  .option('--type <type>', 'Content type: movie or series')
  .option('--season <number>', 'Season number (required for series)', parseInt)
  .option('--episode <number>', 'Episode number (required for series)', parseInt)
  .option('--json', 'Output structured JSON logs', false)
  .action(async (options: {
    guildId: string;
    channelId: string;
    query: string;
    type?: string;
    season?: number;
    episode?: number;
    json: boolean;
  }) => {
    await withSignalHandler(async (signal) => {
      const logLevel =
        (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info';
      const logger = createLogger(logLevel);

      const addonUrl = process.env['STREMIO_ADDON_URL'];
      if (!addonUrl) {
        throw new Error(
          'STREMIO_ADDON_URL is required for play-search. ' +
            'Set it to your Torrentio addon manifest URL (e.g. https://torrentio.strem.fun/…/manifest.json).'
        );
      }

      // Validate content type if provided.
      let contentType: 'movie' | 'series' | undefined;
      if (options.type) {
        if (options.type !== 'movie' && options.type !== 'series') {
          throw new Error('--type must be "movie" or "series".');
        }
        contentType = options.type;
      }

      // Resolve the search query to a direct stream URL.
      const resolved = await Effect.runPromise(
        resolveSearchQuery(addonUrl, {
          query: options.query,
          type: contentType,
          season: options.season,
          episode: options.episode,
        }, logger)
      );

      logger.info('Resolved content for streaming', {
        name: resolved.contentName,
        imdbId: resolved.imdbId,
        quality: resolved.quality,
        filename: resolved.filename,
      });

      // Feed the resolved URL into the standard streaming pipeline.
      await runStreamJob({
        guildId: options.guildId,
        channelId: options.channelId,
        videoUrl: resolved.streamUrl,
        abortSignal: signal,
      });
    });
  });

// ─── play-youtube ───────────────────────────────────────────────────
program
  .command('play-youtube')
  .description(
    'Search YouTube via yt-dlp, resolve a direct stream URL, and stream it'
  )
  .requiredOption('--guild-id <id>', 'Discord guild (server) ID')
  .requiredOption('--channel-id <id>', 'Discord voice channel ID')
  .requiredOption('--query <query>', 'YouTube search query (e.g. "lofi hip hop")')
  .option('--json', 'Output structured JSON logs', false)
  .action(async (options: {
    guildId: string;
    channelId: string;
    query: string;
    json: boolean;
  }) => {
    await withSignalHandler(async (signal) => {
      const logLevel =
        (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info';
      const logger = createLogger(logLevel);

      const ytdlpPath = process.env['YTDLP_PATH'] ?? 'yt-dlp';

      // Resolve the search query to a direct stream URL.
      const resolved = await Effect.runPromise(
        resolveYouTubeQuery(ytdlpPath, options.query, logger)
      );

      logger.info('Resolved YouTube video for streaming', {
        title: resolved.title,
        videoId: resolved.videoId,
        channel: resolved.channel,
        durationSeconds: resolved.durationSeconds,
      });

      // Feed the resolved URL into the standard streaming pipeline.
      // YouTube often returns separate video+audio streams — pass audioUrl
      // so FFmpeg can merge them.
      await runStreamJob({
        guildId: options.guildId,
        channelId: options.channelId,
        videoUrl: resolved.streamUrl,
        abortSignal: signal,
        audioUrl: resolved.audioUrl,
      });
    });
  });

// ─── play-live ──────────────────────────────────────────────────────
program
  .command('play-live')
  .description(
    'Search for a live sports event and stream it to Discord'
  )
  .requiredOption('--guild-id <id>', 'Discord guild (server) ID')
  .requiredOption('--channel-id <id>', 'Discord voice channel ID')
  .requiredOption('--query <query>', 'Event search query (e.g. "nba knicks", "nhl maple leafs")')
  .option('--json', 'Output structured JSON logs', false)
  .action(async (options: {
    guildId: string;
    channelId: string;
    query: string;
    json: boolean;
  }) => {
    await withSignalHandler(async (signal) => {
      const logLevel =
        (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info';
      const logger = createLogger(logLevel);

      const resolved = await Effect.runPromise(
        resolveLiveQuery(options.query, logger)
      );

      logger.info('Resolved live stream for streaming', {
        eventTitle: resolved.eventTitle,
        sport: resolved.sport,
        streamUrl: resolved.streamUrl.slice(0, 80) + '...',
      });

      await runStreamJob({
        guildId: options.guildId,
        channelId: options.channelId,
        videoUrl: resolved.streamUrl,
        abortSignal: signal,
        httpHeaders: resolved.headers,
      });
    });
  });

program.parse();

// ─── Helpers ─────────────────────────────────────────────────────────

async function withSignalHandler(
  fn: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  const abortController = new AbortController();
  const onSignal = () => {
    abortController.abort(new Error('Received shutdown signal'));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await fn(abortController.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal: ${message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

// ─── Stream job options ──────────────────────────────────────────────

interface StreamJobOptions {
  guildId: string;
  channelId: string;
  videoUrl: string;
  abortSignal: AbortSignal;
  audioUrl?: string | undefined;
  httpHeaders?: Record<string, string> | undefined;
  seekSeconds?: number | undefined;
  audioStreamIndex?: number | undefined;
  /** When set, the stream loop will listen for restart events. */
  playbackState?: PlaybackStateManager | undefined;
}

// ─── Core stream job ─────────────────────────────────────────────────

async function runStreamJob(opts: StreamJobOptions): Promise<void> {
  const mainEffect = Effect.gen(function* () {
    const config = yield* ConfigService;
    const daveService = yield* DaveService;
    const gateway = yield* GatewayService;
    const streamerService = yield* StreamerService;
    const media = yield* MediaService;

    const logger = createLogger(config.logLevel);
    logger.info('Starting Discord video stream', {
      guildId: opts.guildId,
      channelId: opts.channelId,
      videoUrl: opts.videoUrl,
      seekSeconds: opts.seekSeconds,
      audioStreamIndex: opts.audioStreamIndex,
    });

    // 1. Load DAVE module
    logger.info('Loading DAVE encryption module');
    const dave = yield* daveService.loadModule;

    // 2. Login to Discord
    logger.info('Authenticating with Discord gateway');
    yield* gateway.login(config.token);
    const user = yield* gateway.currentUser;
    if (!user) {
      throw new Error('Failed to authenticate: no user returned from gateway.');
    }
    logger.info('Authenticated', { userId: user.id, username: user.username });

    // 3. Create streamer
    const streamer = yield* streamerService.create(gateway.client, dave, logger);

    // 4. Detect encoder
    logger.info('Detecting video encoder', { preference: config.videoEncoder });
    const encoderInfo = yield* media.detectEncoder(config.ffmpegPath, config.videoEncoder);
    logger.info('Encoder detected', {
      available: encoderInfo.available,
      selected: encoderInfo.selected,
    });

    // 5. Probe media
    logger.info('Probing media source', { url: opts.videoUrl });
    const probeResult = yield* media.probe(config.ffprobePath, opts.videoUrl, opts.httpHeaders, encoderInfo.ffmpegMajorVersion);

    // 6. Select transcode plan
    const plan = yield* media.selectPlan(probeResult, {
      encoder: encoderInfo.selected,
      subtitleBurnIn: config.subtitleBurnIn,
      performanceProfile: config.performanceProfile,
      language: config.language,
    });

    // When a separate audioUrl is provided (e.g. YouTube split streams),
    // the video URL has no audio track so ffprobe reports none.  Inject
    // a default transcode audio plan so FFmpeg maps the second input.
    if (opts.audioUrl && !plan.audio) {
      (plan as { audio?: unknown }).audio = {
        mode: 'transcode' as const,
        sourceCodec: 'aac',
        sampleRate: 44100,
        channels: 2,
        targetCodec: 'opus' as const,
        targetBitrateKbps: 128 as const,
        targetSampleRate: 48_000 as const,
        targetChannels: 2 as const,
      };
    }

    logger.info('Transcode plan selected', describeTranscodePlan(plan));

    // 7. Join voice channel
    logger.info('Joining voice channel', { guildId: opts.guildId, channelId: opts.channelId });
    yield* streamerService.joinVoice(streamer, opts.guildId, opts.channelId);
    logger.info('Voice channel joined');

    // 8. Create Go Live stream
    logger.info('Creating Go Live stream');
    const streamWebRtc = yield* streamerService.createStream(streamer);

    const streamConnection = streamer.streamConn;
    if (!streamConnection) {
      throw new Error('Stream connection was not created.');
    }

    // Set up packetizer for the stream connection
    const webRtcParams = streamConnection.webRtcParams;
    if (webRtcParams) {
      yield* Effect.tryPromise({
        try: () => streamWebRtc.setPacketizer('H264', webRtcParams),
        catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
      });
    }

    // ── Playback state tracking ────────────────────────────────────
    const pbState = opts.playbackState;
    const duration = probeResult.format?.duration
      ? parseFloat(probeResult.format.duration)
      : 0;

    if (pbState) {
      pbState.startSession(
        opts.guildId, opts.channelId, opts.videoUrl,
        duration, opts.seekSeconds ?? 0,
      );
    }

    // ── Stream loop (supports seek/skip restarts) ──────────────────
    let currentSeek = opts.seekSeconds ?? 0;

    yield* Effect.tryPromise({
      try: async () => {
        // If we have a playback state, set up the restart listener
        const restartEmitter = pbState
          ? pbState.getSession(opts.guildId, opts.channelId)?.restartEmitter
          : undefined;

        let nextSeek: number | null = null;
        let streamAbort: AbortController | null = null;

        const onRestart = (newSeek: number) => {
          logger.info('Restart requested', { currentSeek, newSeek });
          nextSeek = newSeek;
          if (streamAbort) streamAbort.abort(new Error('Seek restart'));
        };

        if (restartEmitter) {
          restartEmitter.on('restart', onRestart);
        }

        try {
          let keepPlaying = true;
          while (keepPlaying) {
            streamAbort = new AbortController();

            // Abort the stream loop when the global signal fires
            const onGlobalAbort = () => streamAbort?.abort(opts.abortSignal.reason);
            opts.abortSignal.addEventListener('abort', onGlobalAbort, { once: true });

            logger.info('Starting FFmpeg pipeline', { seekSeconds: currentSeek });

            const pipeline = await Effect.runPromise(
              media.createPipeline(
                config.ffmpegPath,
                opts.videoUrl,
                plan,
                opts.audioUrl,
                opts.httpHeaders,
                encoderInfo.ffmpegMajorVersion,
                currentSeek > 0 ? currentSeek : undefined,
                opts.audioStreamIndex,
              )
            );

            try {
              // Update playback state with new seek position
              if (pbState) {
                pbState.startSession(
                  opts.guildId, opts.channelId, opts.videoUrl,
                  duration, currentSeek,
                );
              }

              logger.info('Streaming video', { seekSeconds: currentSeek });

              await Effect.runPromise(
                media.playStream(
                  pipeline.output,
                  streamConnection,
                  streamWebRtc,
                  logger,
                  streamAbort.signal,
                  plan.video.mode === 'transcode' ? plan.video.maxBitrateKbps : undefined,
                )
              );

              // Stream ended naturally
              logger.info('Stream completed naturally');
              keepPlaying = false;
            } catch (streamErr) {
              if (nextSeek !== null) {
                // Seek/skip was requested — restart at new position
                logger.info('Restarting stream at new position', { seekSeconds: nextSeek });
                currentSeek = nextSeek;
                nextSeek = null;
                // Stop old FFmpeg process before creating new one
                await pipeline.stop();
                // Brief pause to let streams drain
                await new Promise((r) => setTimeout(r, 500));
                // Loop continues → new pipeline at currentSeek
              } else if (opts.abortSignal.aborted) {
                logger.info('Global shutdown signal received');
                await pipeline.stop();
                keepPlaying = false;
              } else {
                // Unexpected error
                await pipeline.stop();
                throw streamErr;
              }
            } finally {
              opts.abortSignal.removeEventListener('abort', onGlobalAbort);
            }
          }
        } finally {
          if (restartEmitter) {
            restartEmitter.off('restart', onRestart);
          }
        }
      },
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    });

    // Cleanup
    if (pbState) pbState.endSession(opts.guildId, opts.channelId);
    yield* streamerService.leaveVoice(streamer);
    yield* streamerService.destroy(streamer);
    yield* gateway.destroy;
  });

  const configLayer = ConfigServiceLive({
    token: process.env['DISCORD_TOKEN'] ?? '',
    guildId: opts.guildId,
    channelId: opts.channelId,
    videoUrl: opts.videoUrl,
    logLevel: (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    ffmpegPath: process.env['FFMPEG_PATH'] ?? 'ffmpeg',
    ffprobePath: process.env['FFPROBE_PATH'] ?? 'ffprobe',
    stremioAddonUrl: process.env['STREMIO_ADDON_URL'] ?? '',
    ytdlpPath: process.env['YTDLP_PATH'] ?? 'yt-dlp',
    videoEncoder: process.env['VIDEO_ENCODER'] ?? 'auto',
    subtitleBurnIn: process.env['SUBTITLE_BURN_IN'] ?? 'auto',
    performanceProfile: process.env['PERFORMANCE_PROFILE'] ?? 'default',
    language: process.env['LANGUAGE'] ?? 'eng',
  });

  const loggerForGateway = createLogger(
    (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info'
  );
  const gatewayLayer = makeGatewayServiceLive(loggerForGateway);

  const appLayer = pipe(
    configLayer,
    Layer.merge(gatewayLayer),
    Layer.merge(DaveServiceLive),
    Layer.merge(StreamerServiceLive),
    Layer.merge(MediaServiceLive)
  );

  await Effect.runPromise(
    pipe(mainEffect, Effect.provide(appLayer))
  );
}

// ─── Stream job with slash command controls ──────────────────────────

async function runStreamJobWithCommands(
  opts: StreamJobOptions & { botToken: string }
): Promise<void> {
  const logLevel =
    (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info';
  const logger = createLogger(logLevel);

  const playbackState = new PlaybackStateManager();

  const commandServer = new CommandServer({
    botToken: opts.botToken,
    guildId: opts.guildId,
    logger,
    playbackState,
  });

  try {
    await commandServer.start();
    logger.info('Slash command server started — /skip-forward, /skip-backward, /seek, /playtime available');

    await runStreamJob({ ...opts, playbackState });
  } finally {
    await commandServer.stop();
  }
}
