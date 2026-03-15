import type { DaveEncryptorInstance, DaveKeyRatchet, DaveModule } from './types.js';

export class DaveMediaEncryptor {
  private readonly encryptor: DaveEncryptorInstance;
  private framePointer = 0;
  private frameCapacity = 0;

  private hasKeyRatchet = false;

  public constructor(private readonly dave: DaveModule) {
    this.encryptor = new dave.Encryptor();
    this.encryptor.SetPassthroughMode(true);
  }

  public destroy(): void {
    if (this.framePointer !== 0) {
      this.dave._free(this.framePointer);
      this.framePointer = 0;
      this.frameCapacity = 0;
    }
  }

  public assignOpusSsrc(ssrc: number): void {
    this.encryptor.AssignSsrcToCodec(ssrc, this.dave.Codec.Opus);
  }

  public assignH264Ssrc(ssrc: number): void {
    this.encryptor.AssignSsrcToCodec(ssrc, this.dave.Codec.H264);
  }

  public get keyRatchetReady(): boolean {
    return this.hasKeyRatchet;
  }

  public updateSelfKeyRatchet(keyRatchet: DaveKeyRatchet | null): void {
    this.encryptor.SetKeyRatchet(keyRatchet);
    this.encryptor.SetPassthroughMode(keyRatchet === null);
    this.hasKeyRatchet = keyRatchet !== null;
  }

  public encryptAudio(frame: Uint8Array, ssrc: number): Buffer {
    return this.encrypt(this.dave.MediaType.Audio, ssrc, frame);
  }

  public encryptVideo(frame: Uint8Array, ssrc: number): Buffer {
    return this.encrypt(this.dave.MediaType.Video, ssrc, frame);
  }

  private encrypt(mediaType: number, ssrc: number, frame: Uint8Array): Buffer {
    const outputSize = this.encryptor.GetMaxCiphertextByteSize(mediaType, frame.byteLength);
    const framePointer = this.ensureFrameCapacity(outputSize);
    const inputHeap = this.dave.HEAPU8;

    inputHeap.set(frame, framePointer);
    const bytesWritten = this.encryptor.Encrypt(
      mediaType,
      ssrc,
      framePointer,
      frame.byteLength,
      outputSize
    );

    if (bytesWritten <= 0) {
      // When in passthrough mode (no key ratchet yet) or if the encryptor
      // fails for any reason, return the original frame unmodified so that
      // media keeps flowing while the MLS handshake is still in progress.
      return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    }

    const outputHeap = this.dave.HEAPU8;
    const output = Buffer.allocUnsafe(bytesWritten);
    output.set(outputHeap.subarray(framePointer, framePointer + bytesWritten));
    return output;
  }

  private ensureFrameCapacity(requiredCapacity: number): number {
    if (requiredCapacity <= this.frameCapacity && this.framePointer !== 0) {
      return this.framePointer;
    }

    if (this.framePointer !== 0) {
      this.dave._free(this.framePointer);
    }

    this.framePointer = this.dave._malloc(requiredCapacity);
    this.frameCapacity = requiredCapacity;
    return this.framePointer;
  }
}
