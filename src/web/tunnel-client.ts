import { TunnelClient as CoreTunnelClient } from "../tunnel/client";
import { rtcDataChannelTransport } from "../tunnel/rtc-datachannel";

export type { TunnelLike, TunnelWsHandle, TunnelWsHandlers } from "../tunnel/client";

/**
 * Browser-side end of the tunnel over RTCDataChannel lanes. Convenience over
 * the transport-agnostic client in src/tunnel/ — see there for the protocol.
 */
export class TunnelClient extends CoreTunnelClient {
  /**
   * `channel` carries the interactive traffic (WebSocket frames — VS Code's
   * remote protocol, terminals); `bulk`, when provided and open, carries HTTP
   * request/response streams on its own SCTP stream so multi-MB asset bodies
   * never head-of-line block a keystroke.
   */
  constructor(channel: RTCDataChannel, bulk: RTCDataChannel | null = null) {
    super(rtcDataChannelTransport(channel), bulk ? rtcDataChannelTransport(bulk) : null);
  }
}
