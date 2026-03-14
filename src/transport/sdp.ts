import { codecPayloadType } from './codec.js';

/**
 * Build a remote SDP answer from Discord's SDP response.
 * Discord sends a partial SDP; we reconstruct a full SDP answer
 * with proper audio and video media sections.
 */
export function buildRemoteSdp(discordSdp: string): string {
  let connectionLine = '';
  let port = '';
  let iceUser = '';
  let icePassword = '';
  let fingerprint = '';
  let candidate = '';

  for (const line of discordSdp.split('\n')) {
    if (line.startsWith('c=')) {
      connectionLine = line;
    } else if (line.startsWith('a=rtcp')) {
      port = line.split(':')[1] || '';
    } else if (line.startsWith('a=ice-ufrag')) {
      iceUser = line;
    } else if (line.startsWith('a=ice-pwd')) {
      icePassword = line;
    } else if (line.startsWith('a=fingerprint')) {
      fingerprint = line;
    } else if (line.startsWith('a=candidate')) {
      candidate = line;
    }
  }

  const audioSection = `
m=audio ${port} UDP/TLS/RTP/SAVPF ${codecPayloadType.opus.payload_type}
${connectionLine}
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=setup:passive
a=mid:0
a=maxptime:60
a=inactive
${iceUser}
${icePassword}
${fingerprint}
${candidate}
a=rtcp-mux
a=rtpmap:${codecPayloadType.opus.payload_type} opus/48000/2
a=fmtp:${codecPayloadType.opus.payload_type} minptime=10;useinbandfec=1;usedtx=1
a=rtcp-fb:${codecPayloadType.opus.payload_type} transport-cc
a=rtcp-fb:${codecPayloadType.opus.payload_type} nack
a=ice-lite
`.trim();

  const videoSection = `
m=video ${port} UDP/TLS/RTP/SAVPF ${codecPayloadType.H264.payload_type} ${codecPayloadType.H264.rtx_payload_type}
${connectionLine}
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:14 urn:ietf:params:rtp-hdrext:toffset
a=extmap:13 urn:3gpp:video-orientation
a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay
a=setup:passive
a=mid:1
a=inactive
${iceUser}
${icePassword}
${fingerprint}
${candidate}
a=rtcp-mux
a=ice-lite
a=rtpmap:${codecPayloadType.H264.payload_type} H264/90000
a=rtpmap:${codecPayloadType.H264.rtx_payload_type} rtx/90000
a=fmtp:${codecPayloadType.H264.rtx_payload_type} apt=${codecPayloadType.H264.payload_type}
a=rtcp-fb:${codecPayloadType.H264.payload_type} ccm fir
a=rtcp-fb:${codecPayloadType.H264.payload_type} nack
a=rtcp-fb:${codecPayloadType.H264.payload_type} nack pli
a=rtcp-fb:${codecPayloadType.H264.payload_type} goog-remb
a=rtcp-fb:${codecPayloadType.H264.payload_type} transport-cc
`.trim();

  return `${audioSection}\n${videoSection}`;
}
