/**
 * Type definitions for the vendored libdave WASM module.
 * These mirror the C++ API exposed through Emscripten bindings.
 */

export type DaveKeyRatchet = {
  cipherSuite: number;
  baseSecret: number[];
};

export interface DaveTransientKeys {
  GetTransientPrivateKey(protocolVersion: number): unknown;
}

export interface DaveSessionInstance {
  Init(
    protocolVersion: number,
    groupId: bigint,
    selfUserId: string,
    transientKey: unknown
  ): void;
  Reset(): void;
  SetProtocolVersion(version: number): void;
  GetProtocolVersion(): number;
  SetExternalSender(externalSender: number[]): void;
  GetMarshalledKeyPackage(): number[];
  ProcessProposals(proposals: number[], recognizedUserIds: string[]): number[] | null;
  ProcessCommit(commit: number[]): {
    ignored: boolean;
    failed: boolean;
    rosterUpdate: unknown | null;
  };
  ProcessWelcome(welcome: number[], recognizedUserIds: string[]): unknown | null;
  GetKeyRatchet(userId: string): DaveKeyRatchet | null;
}

export interface DaveEncryptorInstance {
  AssignSsrcToCodec(ssrc: number, codec: number): void;
  SetKeyRatchet(keyRatchet: DaveKeyRatchet | null): void;
  SetPassthroughMode(passthrough: boolean): void;
  GetMaxCiphertextByteSize(mediaType: number, plaintextSize: number): number;
  Encrypt(
    mediaType: number,
    ssrc: number,
    framePointer: number,
    frameLength: number,
    capacity: number
  ): number;
}

export interface DaveModule {
  Session: new (
    a: string,
    b: string,
    onFailure: (source: string, reason: string) => void
  ) => DaveSessionInstance;
  Encryptor: new () => DaveEncryptorInstance;
  TransientKeys: new () => DaveTransientKeys;
  Codec: { Opus: number; H264: number; VP8: number; VP9: number; H265: number; AV1: number };
  MediaType: { Audio: number; Video: number };
  MaxSupportedProtocolVersion(): number;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
}
