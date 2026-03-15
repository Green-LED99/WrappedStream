import 'dotenv/config';
import { Effect, Layer, pipe } from 'effect';
import { Command } from 'commander';
import { ConfigService, ConfigServiceLive } from './config/loader.js';
import { DaveService, DaveServiceLive } from './discord/dave/DaveService.js';
import { GatewayService, makeGatewayServiceLive } from './discord/gateway/GatewayService.js';
import { GatewayOpcode } from './discord/gateway/opcodes.js';
import { StreamerService, StreamerServiceLive } from './discord/streamer/StreamerService.js';
import { MediaService, MediaServiceLive } from './media/MediaService.js';
import { describeTranscodePlan } from './media/TranscodePlan.js';
import { createLogger, type Logger } from './utils/logger.js';

const program = new Command()
  .name('discord-stream')
  .description('Stream video to a Discord voice channel via Go Live')
  .version('0.1.0');

program
  .command('play-url')
  .description('Stream a video URL to a Discord voice channel')
  .requiredOption('--guild-id <id>', 'Discord guild (server) ID')
  .requiredOption('--channel-id <id>', 'Discord voice channel ID')
  .requiredOption('--url <url>', 'Direct video URL (mp4/mkv)')
  .option('--json', 'Output structured JSON logs', false)
  .action(async (options: {
    guildId: string;
    channelId: string;
    url: string;
    json: boolean;
  }) => {
    const abortController = new AbortController();

    const onSignal = () => {
      abortController.abort(new Error('Received shutdown signal'));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
      await runStreamJob(
        options.guildId,
        options.channelId,
        options.url,
        abortController.signal
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Fatal: ${message}\n`);
      process.exitCode = 1;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  });

program.parse();

async function runStreamJob(
  guildId: string,
  channelId: string,
  videoUrl: string,
  abortSignal: AbortSignal
): Promise<void> {
  const mainEffect = Effect.gen(function* () {
    const config = yield* ConfigService;
    const daveService = yield* DaveService;
    const gateway = yield* GatewayService;
    const streamerService = yield* StreamerService;
    const media = yield* MediaService;

    const logger = createLogger(config.logLevel);
    logger.info('Starting Discord video stream', {
      guildId,
      channelId,
      videoUrl,
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

    // 4. Probe media
    logger.info('Probing media source', { url: videoUrl });
    const probeResult = yield* media.probe(config.ffprobePath, videoUrl);

    // 5. Select transcode plan
    const plan = yield* media.selectPlan(probeResult);
    logger.info('Transcode plan selected', describeTranscodePlan(plan));

    // 6. Join voice channel
    logger.info('Joining voice channel', { guildId, channelId });
    yield* streamerService.joinVoice(streamer, guildId, channelId);
    logger.info('Voice channel joined');

    // 7. Spawn FFmpeg
    logger.info('Starting FFmpeg pipeline');
    const pipeline = yield* media.createPipeline(
      config.ffmpegPath,
      videoUrl,
      plan
    );

    // 8. Create Go Live stream and play
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

    logger.info('Streaming video');
    yield* media.playStream(
      pipeline.output,
      streamConnection,
      streamWebRtc,
      logger,
      abortSignal
    );

    // Wait for FFmpeg to finish or handle its error
    yield* Effect.tryPromise({
      try: () =>
        Promise.race([
          pipeline.wait,
          new Promise<void>((_, reject) => {
            if (abortSignal.aborted) {
              reject(abortSignal.reason);
              return;
            }
            abortSignal.addEventListener('abort', () => reject(abortSignal.reason), {
              once: true,
            });
          }),
        ]),
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    });

    logger.info('Stream completed successfully');

    // Cleanup
    pipeline.stop();
    yield* streamerService.leaveVoice(streamer);
    yield* streamerService.destroy(streamer);
    yield* gateway.destroy;
  });

  const configLayer = ConfigServiceLive({
    token: process.env['DISCORD_TOKEN'] ?? '',
    guildId,
    channelId,
    videoUrl,
    logLevel: (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    ffmpegPath: process.env['FFMPEG_PATH'] ?? 'ffmpeg',
    ffprobePath: process.env['FFPROBE_PATH'] ?? 'ffprobe',
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
