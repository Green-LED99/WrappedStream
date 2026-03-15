import { Context, Effect, Layer } from 'effect';
import { DaveError } from '../../errors/index.js';
import type { DaveModule, DaveTransientKeys } from './types.js';
import { loadDaveModule } from './loader.js';

export class DaveService extends Context.Tag('DaveService')<
  DaveService,
  {
    readonly loadModule: Effect.Effect<DaveModule, DaveError>;
    readonly createTransientKeys: (
      dave: DaveModule
    ) => Effect.Effect<DaveTransientKeys, DaveError>;
  }
>() {}

export const DaveServiceLive = Layer.succeed(DaveService, {
  loadModule: Effect.tryPromise({
    try: () => loadDaveModule(),
    catch: (error) =>
      new DaveError({
        message: error instanceof Error ? error.message : String(error),
        details: { phase: 'wasm_load' },
      }),
  }),

  createTransientKeys: (dave: DaveModule) =>
    Effect.try({
      try: () => new dave.TransientKeys(),
      catch: (error) =>
        new DaveError({
          message: error instanceof Error ? error.message : String(error),
          details: { phase: 'transient_keys' },
        }),
    }),
});
