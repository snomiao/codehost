import { type PeerMeta, newPeerId } from "../shared/signaling";
import { SignalingClient } from "../shared/signaling-client";
import { RtcDaemon } from "./rtc-daemon";
import { Tunnel } from "./tunnel";

export interface LaunchResult {
  /** Local port to tunnel to. */
  port: number;
  /** Stop the launched process, if any. */
  stop?: () => void;
  /**
   * Prefix the Tunnel should strip before forwarding (so an arbitrary server
   * that doesn't know about /vs/<peerId> still gets clean paths). Left undefined
   * for VS Code, which is launched with --server-base-path and wants the prefix.
   */
  stripBasePath?: string;
}

export interface RunServerOptions {
  token: string;
  signal: string;
  meta: PeerMeta;
  /** One-line description for the startup log. */
  label: string;
  /** Prepare the local target to tunnel, given the /vs/<peerId> base path. */
  launch: (basePath: string) => Promise<LaunchResult>;
}

/**
 * Foreground server loop shared by `serve`, `dev`, and `expose`: register in the
 * signaling room with the given meta and bridge each viewer's data channel to a
 * local server (VS Code for serve/dev, an arbitrary port for expose). Never
 * resolves.
 */
export async function runServer(opts: RunServerOptions): Promise<never> {
  const peerId = newPeerId();
  const basePath = `/vs/${peerId}`;

  console.log(`[codehost] ${opts.label}`);
  console.log(`[codehost] room token: ${opts.token}`);
  console.log(`[codehost] signaling:  ${opts.signal}`);

  const target = await opts.launch(basePath);

  let rtc: RtcDaemon;
  const client = new SignalingClient({
    url: opts.signal,
    token: opts.token,
    role: "server",
    peerId,
    meta: opts.meta,
    onOpen: () => console.log(`[codehost] registered as "${opts.meta.name}" (${peerId.slice(0, 8)})`),
    onClose: (info) => {
      // Surface the close code + how long the socket lived: a near-instant drop
      // (low ms) points at a middlebox killing the WebSocket after the upgrade,
      // not the signaling server. Helps triage field reconnect storms.
      const detail = info ? ` (code ${info.code}${info.reason ? ` "${info.reason}"` : ""}, up ${info.ms}ms)` : "";
      console.log(`[codehost] disconnected from signaling${detail}, reconnecting…`);
    },
    onSignal: (from, data) => rtc.handleSignal(from, data),
  });

  rtc = new RtcDaemon({
    sendSignal: (to, data) => client.sendSignal(to, data),
    onChannel: (viewerId, channel) => {
      console.log(`[codehost] viewer ${viewerId.slice(0, 8)} connected; bridging to :${target.port}`);
      new Tunnel(channel, target.port, target.stripBasePath);
    },
  });

  client.connect();

  const shutdown = () => {
    console.log("\n[codehost] shutting down");
    rtc.closeAll();
    client.close();
    target.stop?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<never>(() => {});
}
