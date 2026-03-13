import { Data } from 'effect';

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly message: string;
  readonly details?: Record<string, unknown>;
}> {}

export class AuthError extends Data.TaggedError('AuthError')<{
  readonly message: string;
  readonly closeCode?: number;
}> {}

export class GatewayError extends Data.TaggedError('GatewayError')<{
  readonly message: string;
  readonly closeCode?: number;
  readonly closeReason?: string;
}> {}

export class VoiceGatewayError extends Data.TaggedError('VoiceGatewayError')<{
  readonly message: string;
  readonly closeCode?: number;
  readonly closeReason?: string;
}> {}

export class DaveError extends Data.TaggedError('DaveError')<{
  readonly message: string;
  readonly details?: Record<string, unknown>;
}> {}

export class MediaError extends Data.TaggedError('MediaError')<{
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
}> {}

export class TransportError extends Data.TaggedError('TransportError')<{
  readonly message: string;
}> {}

export enum ExitCode {
  Ok = 0,
  Config = 10,
  Auth = 20,
  Gateway = 30,
  Media = 40,
  Dave = 50,
  Transport = 60,
  Internal = 70,
}
