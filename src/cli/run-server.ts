import { type PeerMeta, newPeerId } from "../shared/signaling";
import { SignalingClient } from "../shared/signaling-client";
import { RtcDaemon } from "./rtc-daemon";
import { launchVscode } from "./vscode";
import { Tunnel } from "./tunnel";

export interface RunServerOptions {
  /** Folder serve-web roots at: the workspace root (serve) or the repo (dev). */
  dir: string;
  token: string;
  signal: string;
  meta: PeerMeta;
  port?: number;
}

/**
 * Foreground server loop shared by `serve` and `dev`: launch VS Code under
 * /vs/<peerId>, register in the signaling room with the given meta, and bridge
 * each viewer's data channel to the local VS Code server. Never resolves.
 */
export async function runServer(opts: RunServerOptions): Promise<never> {
  const peerId = newPeerId();
  const basePath = `/vs/${peerId}`;

  console.log(`[codehost] serving ${opts.dir}`);
  console.log(`[codehost] room token: ${opts.token}`);
  console.log(`[codehost] signaling:  ${opts.signal}`);

  const vscode = await launchVscode({ dir: opts.dir, basePath, port: opts.port });

  let rtc: RtcDaemon;
  const client = new SignalingClient({
    url: opts.signal,
    token: opts.token,
    role: "server",
    peerId,
    meta: opts.meta,
    onOpen: () => console.log(`[codehost] registered as "${opts.meta.name}" (${peerId.slice(0, 8)})`),
    onClose: () => console.log("[codehost] disconnected from signaling, reconnecting…"),
    onSignal: (from, data) => rtc.handleSignal(from, data),
  });

  rtc = new RtcDaemon({
    sendSignal: (to, data) => client.sendSignal(to, data),
    onChannel: (viewerId, channel) => {
      console.log(`[codehost] viewer ${viewerId.slice(0, 8)} connected; bridging to VS Code`);
      new Tunnel(channel, vscode.port);
    },
  });

  client.connect();

  const shutdown = () => {
    console.log("\n[codehost] shutting down");
    rtc.closeAll();
    client.close();
    vscode.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<never>(() => {});
}
