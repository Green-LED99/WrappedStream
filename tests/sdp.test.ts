import { describe, expect, it } from 'vitest';
import { buildRemoteSdp } from '../src/transport/sdp.js';

describe('buildRemoteSdp', () => {
  const discordSdp = [
    'v=0',
    'o=- 1234567890 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'c=IN IP4 198.51.100.1',
    'a=rtcp:50000',
    'a=ice-ufrag:abcdef',
    'a=ice-pwd:ghijklmnopqrstuvwxyz123456',
    'a=fingerprint:sha-256 AA:BB:CC:DD',
    'a=candidate:1 1 UDP 2130706431 198.51.100.1 50000 typ host',
  ].join('\n');

  it('produces SDP with audio m-line', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('m=audio');
  });

  it('produces SDP with video m-line', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('m=video');
  });

  it('includes opus codec for audio', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('opus/48000/2');
  });

  it('includes H264 codec for video', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('H264/90000');
  });

  it('includes ICE credentials from Discord SDP', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('a=ice-ufrag:abcdef');
    expect(result).toContain('a=ice-pwd:ghijklmnopqrstuvwxyz123456');
  });

  it('includes fingerprint from Discord SDP', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('a=fingerprint:sha-256 AA:BB:CC:DD');
  });

  it('includes connection line from Discord SDP', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('c=IN IP4 198.51.100.1');
  });

  it('includes candidate from Discord SDP', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('a=candidate:1 1 UDP');
  });

  it('includes rtx codec for video', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('rtx/90000');
  });

  it('includes ice-lite', () => {
    const result = buildRemoteSdp(discordSdp);
    expect(result).toContain('a=ice-lite');
  });

  it('includes transport-cc feedback for both audio and video', () => {
    const result = buildRemoteSdp(discordSdp);
    const transportCcMatches = result.match(/transport-cc/g);
    expect(transportCcMatches?.length).toBeGreaterThanOrEqual(2);
  });
});
