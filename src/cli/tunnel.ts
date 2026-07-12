import type { DataChannel } from "node-datachannel";
import { type LocalHandler, TunnelHost } from "../tunnel/host";
import { nodeDataChannelTransport } from "../tunnel/node-datachannel";

export type { LocalHandler, LocalRequest } from "../tunnel/host";

/**
 * Bridges one WebRTC data channel to a local `code serve-web` instance.
 * Daemon-side convenience over the transport-agnostic TunnelHost
 * (src/tunnel/) — see there for the protocol and proxy logic.
 */
export class Tunnel extends TunnelHost {
  constructor(channel: DataChannel, vscodePort: number, stripPrefix?: string, onLocal?: LocalHandler) {
    super(nodeDataChannelTransport(channel), { port: vscodePort, stripPrefix, onLocal });
  }
}
