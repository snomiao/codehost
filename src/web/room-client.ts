import { SignalingClient } from "../shared/signaling-client";
import type { PeerInfo } from "../shared/signaling";
import type { RtcSignal } from "../shared/rtc";
import { RtcClient } from "./rtc-client";
import { TunnelClient } from "./tunnel-client";

// Embeddable codehost room client for OTHER sites (agent-yes.com first): join a
// room as a viewer, watch the peer list (hosts advertise workspaces + agents in
// PeerMeta), and speak HTTP to any server peer over a lazily-dialed WebRTC
// tunnel. No Service Worker, no React, no cross-tab broker — one module that
// `bun build --target browser` bundles standalone (see scripts.build:lib).

export type { AgentInfo, PeerInfo, PeerMeta, WorkspaceInfo } from "../shared/signaling";

export const DEFAULT_SIGNAL_URL = "wss://signal.codehost.dev";

export interface RoomOptions {
  /** Room token (bearer secret — same one `codehost serve -t` uses). */
  token: string;
  /** Signaling server (default wss://signal.codehost.dev). */
  signalUrl?: string;
  /** Live server-peer list, fired on every room membership/meta change. */
  onPeers?: (peers: PeerInfo[]) => void;
  /** Signaling socket state. */
  onStatus?: (open: boolean) => void;
}

export class CodehostRoom {
  /** Server peers currently in the room (viewers filtered out). */
  peers: PeerInfo[] = [];
  private signaling: SignalingClient;
  private rtcs = new Map<string, RtcClient>();
  private tunnels = new Map<string, Promise<TunnelClient>>();
  private closed = false;

  constructor(opts: RoomOptions) {
    this.signaling = new SignalingClient({
      url: opts.signalUrl ?? DEFAULT_SIGNAL_URL,
      token: opts.token,
      role: "viewer",
      onOpen: () => opts.onStatus?.(true),
      onClose: () => opts.onStatus?.(false),
      onPeers: (peers) => {
        this.peers = peers.filter((p) => p.role === "server");
        opts.onPeers?.(this.peers);
      },
      onSignal: (from, data) => void this.rtcs.get(from)?.handleSignal(data),
    });
    this.signaling.connect();
  }

  /** HTTP over the peer's tunnel (dialed on first use, reused after). The
   *  response streams — long-lived SSE bodies work. */
  async fetch(
    peerId: string,
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: Uint8Array | string } = {},
  ): Promise<Response> {
    const tunnel = await this.dial(peerId);
    const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
    return tunnel.fetch(method, path, init.headers ?? {}, body);
  }

  private dial(peerId: string): Promise<TunnelClient> {
    const existing = this.tunnels.get(peerId);
    if (existing) return existing;
    const drop = () => {
      this.tunnels.delete(peerId);
      this.rtcs.get(peerId)?.close();
      this.rtcs.delete(peerId);
    };
    const dialing = new Promise<TunnelClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        drop();
        reject(new Error("dial timed out"));
      }, 15000);
      const rtc = new RtcClient({
        sendSignal: (data: RtcSignal) => this.signaling.sendSignal(peerId, data),
        onOpen: (channel) => {
          clearTimeout(timer);
          resolve(new TunnelClient(channel));
        },
        onClose: drop,
        onState: (state) => {
          if (state === "failed" || state === "disconnected") drop();
        },
      });
      this.rtcs.set(peerId, rtc);
      rtc.start().catch((err) => {
        clearTimeout(timer);
        drop();
        reject(err);
      });
    });
    this.tunnels.set(peerId, dialing);
    dialing.catch(() => this.tunnels.delete(peerId));
    return dialing;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const rtc of this.rtcs.values()) rtc.close();
    this.rtcs.clear();
    this.tunnels.clear();
    this.signaling.close();
  }
}

/** Join a codehost room as a viewer. */
export function joinRoom(opts: RoomOptions): CodehostRoom {
  return new CodehostRoom(opts);
}
