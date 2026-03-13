import { Context, Effect, Layer } from 'effect';
import { AuthError, GatewayError } from '../../errors/index.js';
import type { Logger } from '../../utils/logger.js';
import { GatewayClient, type GatewaySessionSnapshot, type VoiceJoinPreflight } from './GatewayClient.js';
import type { GatewayEvent, GatewayUser, RawGatewayListener } from './events.js';

export class GatewayService extends Context.Tag('GatewayService')<
  GatewayService,
  {
    readonly login: (token: string) => Effect.Effect<void, AuthError | GatewayError>;
    readonly destroy: Effect.Effect<void>;
    readonly sendOpcode: (opcode: number, payload: unknown) => Effect.Effect<void>;
    readonly currentUser: Effect.Effect<GatewayUser | null>;
    readonly onRaw: (listener: RawGatewayListener) => Effect.Effect<void>;
    readonly offRaw: (listener: RawGatewayListener) => Effect.Effect<void>;
    readonly preflightVoiceJoin: (
      guildId: string,
      channelId: string
    ) => Effect.Effect<VoiceJoinPreflight, GatewayError>;
    readonly waitForEvent: <T extends GatewayEvent>(
      eventType: T['t'],
      timeoutMs: number
    ) => Effect.Effect<T['d'], GatewayError>;
    readonly sessionSnapshot: Effect.Effect<GatewaySessionSnapshot>;
    readonly client: GatewayClient;
  }
>() {}

export function makeGatewayServiceLive(logger: Logger) {
  return Layer.sync(GatewayService, () => {
    const client = new GatewayClient(logger.child('gateway'));

    return {
      login: (token: string) =>
        Effect.tryPromise({
          try: () => client.login(token),
          catch: (error) => {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('rejected the token') || msg.includes('4004')) {
              return new AuthError({ message: msg });
            }
            return new GatewayError({ message: msg });
          },
        }),

      destroy: Effect.sync(() => client.destroy()),

      sendOpcode: (opcode: number, payload: unknown) =>
        Effect.sync(() => client.sendGatewayOpcode(opcode, payload)),

      currentUser: Effect.sync(() => client.currentUser()),

      onRaw: (listener: RawGatewayListener) => Effect.sync(() => client.onRaw(listener)),

      offRaw: (listener: RawGatewayListener) => Effect.sync(() => client.offRaw(listener)),

      preflightVoiceJoin: (guildId: string, channelId: string) =>
        Effect.tryPromise({
          try: () => client.preflightVoiceJoin(guildId, channelId),
          catch: (error) =>
            new GatewayError({ message: error instanceof Error ? error.message : String(error) }),
        }),

      waitForEvent: <T extends GatewayEvent>(eventType: T['t'], timeoutMs: number) =>
        Effect.async<T['d'], GatewayError>((resume) => {
          const timeout = setTimeout(() => {
            client.offRaw(listener);
            resume(
              Effect.fail(
                new GatewayError({
                  message: `Timed out waiting for ${eventType} (${timeoutMs}ms)`,
                })
              )
            );
          }, timeoutMs);

          const listener: RawGatewayListener = (event) => {
            if (event.t !== eventType) return;
            clearTimeout(timeout);
            client.offRaw(listener);
            resume(Effect.succeed(event.d as T['d']));
          };

          client.onRaw(listener);

          return Effect.sync(() => {
            clearTimeout(timeout);
            client.offRaw(listener);
          });
        }),

      sessionSnapshot: Effect.sync(() => client.sessionSnapshot()),

      client,
    };
  });
}
