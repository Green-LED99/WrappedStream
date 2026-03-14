import type {
  H264RtpPacketizer,
  PeerConnection,
  RtpPacketizer,
  Track,
} from '@lng2004/node-datachannel';
import type { DaveMediaEncryptor } from '../discord/dave/DaveEncryptor.js';
import type { Logger } from '../utils/logger.js';
import { codecPayloadType } from './codec.js';

type SupportedVideoCodec = 'H264';
type NodeDataChannelModule = typeof import('@lng2004/node-datachannel');

export type WebRtcParameters = {
  address: string;
  port: number;
  audioSsrc: number;
  videoSsrc: number;
  rtxSsrc: number;
};

function asSendBuffer(frame: Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(frame)) {
    return frame;
  }
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
}

export class WebRtcConnection {
  private rtc?: NodeDataChannelModule;
  private peerConnection: PeerConnection | undefined;
  private audioTrack: Track | undefined;
  private videoTrack: Track | undefined;
  private audioPacketizer: RtpPacketizer | undefined;
  private videoPacketizer: H264RtpPacketizer | undefined;
  private videoCodec: SupportedVideoCodec | undefined;

  public constructor(
    private readonly logger: Logger,
    private readonly getDaveEncryptor: () => DaveMediaEncryptor | null,
    private readonly isDaveReady: () => boolean,
    private readonly getAudioSsrc: () => number,
    private readonly getVideoSsrc: () => number
  ) {}

  public async initWebRtc(): Promise<PeerConnection> {
    const rtc = await this.loadRtcModule();
    this.close();
    this.peerConnection = new rtc.PeerConnection('', {
      iceServers: ['stun:stun.l.google.com:19302'],
    });

    const audioDefinition = new rtc.Audio('0', 'SendRecv');
    audioDefinition.addOpusCodec(codecPayloadType.opus.payload_type);

    const videoDefinition = new rtc.Video('1', 'SendRecv');
    videoDefinition.addH264Codec(codecPayloadType.H264.payload_type);
    videoDefinition.addRTXCodec(
      codecPayloadType.H264.rtx_payload_type,
      codecPayloadType.H264.payload_type,
      codecPayloadType.H264.clockRate
    );

    this.audioTrack = this.peerConnection.addTrack(audioDefinition);
    this.videoTrack = this.peerConnection.addTrack(videoDefinition);
    this.setMediaHandler();

    return this.peerConnection;
  }

  public close(): void {
    this.peerConnection?.close();
    this.peerConnection = undefined;
    this.audioTrack = undefined;
    this.videoTrack = undefined;
    this.audioPacketizer = undefined;
    this.videoPacketizer = undefined;
    this.videoCodec = undefined;
  }

  public getPeerConnection(): PeerConnection | undefined {
    return this.peerConnection;
  }

  public get ready(): boolean {
    return this.peerConnection?.state?.() === 'connected';
  }

  public sendAudioFrame(frame: Uint8Array, frameTimeMs: number): void {
    if (!this.ready || !this.audioPacketizer) return;

    const packetizer = this.audioPacketizer;
    const rtpConfig = packetizer.rtpConfig;

    const encryptor = this.getDaveEncryptor();
    const payload =
      this.isDaveReady() && encryptor
        ? encryptor.encryptAudio(frame, this.getAudioSsrc())
        : frame;

    this.audioTrack?.sendMessageBinary(asSendBuffer(payload));
    rtpConfig.timestamp += Math.round((frameTimeMs * rtpConfig.clockRate) / 1000);
  }

  public sendVideoFrame(frame: Uint8Array, frameTimeMs: number): void {
    if (!this.ready || !this.videoPacketizer) return;

    const packetizer = this.videoPacketizer;
    const rtpConfig = packetizer.rtpConfig;

    const encryptor = this.getDaveEncryptor();
    const payload =
      this.isDaveReady() && encryptor
        ? encryptor.encryptVideo(frame, this.getVideoSsrc())
        : frame;

    this.videoTrack?.sendMessageBinary(asSendBuffer(payload));
    rtpConfig.timestamp += Math.round((frameTimeMs * rtpConfig.clockRate) / 1000);
  }

  public async setPacketizer(
    videoCodec: SupportedVideoCodec,
    params: WebRtcParameters
  ): Promise<void> {
    const rtc = await this.loadRtcModule();

    const audioRtpConfig = new rtc.RtpPacketizationConfig(
      params.audioSsrc,
      '',
      codecPayloadType.opus.payload_type,
      codecPayloadType.opus.clockRate
    );
    audioRtpConfig.playoutDelayId = 5;
    audioRtpConfig.playoutDelayMin = 0;
    audioRtpConfig.playoutDelayMax = 1;
    this.audioPacketizer = new rtc.RtpPacketizer(audioRtpConfig);
    this.audioPacketizer.addToChain(new rtc.RtcpSrReporter(audioRtpConfig));
    this.audioPacketizer.addToChain(new rtc.RtcpNackResponder());

    this.videoCodec = videoCodec;
    const videoRtpConfig = new rtc.RtpPacketizationConfig(
      params.videoSsrc,
      '',
      codecPayloadType.H264.payload_type,
      codecPayloadType.H264.clockRate
    );
    videoRtpConfig.playoutDelayId = 5;
    videoRtpConfig.playoutDelayMin = 0;
    videoRtpConfig.playoutDelayMax = 10;

    this.videoPacketizer = new rtc.H264RtpPacketizer('StartSequence', videoRtpConfig);
    this.videoPacketizer.addToChain(new rtc.RtcpSrReporter(videoRtpConfig));
    this.videoPacketizer.addToChain(new rtc.RtcpNackResponder());
    this.videoPacketizer.addToChain(new rtc.PacingHandler(25 * 1000 * 1000, 1));

    this.setMediaHandler();
    this.logger.debug('RTP packetizers configured', {
      audioSsrc: params.audioSsrc,
      videoSsrc: params.videoSsrc,
    });
  }

  private setMediaHandler(): void {
    if (this.audioPacketizer) {
      this.audioTrack?.setMediaHandler(this.audioPacketizer);
    }
    if (this.videoPacketizer) {
      this.videoTrack?.setMediaHandler(this.videoPacketizer);
    }
  }

  private async loadRtcModule(): Promise<NodeDataChannelModule> {
    if (!this.rtc) {
      this.rtc = await import('@lng2004/node-datachannel');
    }
    return this.rtc;
  }
}
