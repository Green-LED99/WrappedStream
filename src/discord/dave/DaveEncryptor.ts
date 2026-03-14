import type { DaveEncryptorInstance, DaveKeyRatchet, DaveModule } from './types.js';

export class DaveMediaEncryptor {
  private readonly encryptor: DaveEncryptorInstance;
  private framePointer = 0;
  private frameCapacity = 0;

  public constructor(private readonly dave: DaveModule) {
    this.encryptor = new dave.Encryptor();
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

  public updateSelfKeyRatchet(keyRatchet: DaveKeyRatchet | null): void {
    this.encryptor.SetKeyRatchet(keyRatchet);
    this.encryptor.SetPassthroughMode(keyRatchet === null);
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
      throw new Error(`libdave encryptor returned no ciphertext (mediaType=${mediaType}, ssrc=${ssrc})`);
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
