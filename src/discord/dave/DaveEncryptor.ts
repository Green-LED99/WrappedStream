import type { DaveEncryptorInstance, DaveKeyRatchet, DaveModule } from './types.js';

export class DaveMediaEncryptor {
  private readonly encryptor: DaveEncryptorInstance;
  private framePointer = 0;
  private frameCapacity = 0;

  // Reusable output buffer — avoids a Buffer.allocUnsafe() on every frame.
  // At 30 fps video + ~50 fps audio this eliminates ~80 allocations/second
  // and the associated GC pressure on ARM (Jetson Nano).
  // Pre-allocate 16 KB to cover typical video frames (~8-50 KB) and avoid
  // the first-frame allocation stall.  Audio frames (~150 B) fit trivially.
  private outputBuffer: Buffer = Buffer.allocUnsafe(16_384);
  private outputCapacity = 16_384;

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

    // Grow the reusable output buffer only when needed (grow-only strategy
    // mirrors ensureFrameCapacity).  We copy into a slice of the pooled
    // buffer and return that slice — no per-frame allocation.
    if (bytesWritten > this.outputCapacity) {
      this.outputBuffer = Buffer.allocUnsafe(bytesWritten);
      this.outputCapacity = bytesWritten;
    }

    const outputHeap = this.dave.HEAPU8;
    this.outputBuffer.set(
      outputHeap.subarray(framePointer, framePointer + bytesWritten)
    );

    // Return a view of the exact bytes written.  Since the downstream
    // consumer (sendMessageBinary) copies into the RTP packetizer before
    // this method is called again, reusing the underlying buffer is safe.
    return this.outputBuffer.subarray(0, bytesWritten) as Buffer;
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
