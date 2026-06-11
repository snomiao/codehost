import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type PeerMeta, newPeerId } from "../shared/signaling";
import { SignalingClient } from "../shared/signaling-client";
import { RtcDaemon } from "./rtc-daemon";
import { type LocalRequest, Tunnel } from "./tunnel";
import { handleProvision, isProvisionPath, type ProvisionDeps } from "./provision-server";
import { type DaemonPlugin, routePlugins } from "./plugins/types";

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
  /** Enables `/__codehost/provision` on the tunnel (serve only — runs the home's
   *  setup.sh). Omitted by `expose`, which has no home/workspace. */
  provision?: ProvisionDeps;
  /** Recompute the advertised meta (e.g. re-enumerate workspaces). Polled on
   *  an interval and right after each provision; pushed to the room only when
   *  it actually changed. */
  refreshMeta?: () => PeerMeta;
  /** Meta poll cadence (default META_REFRESH_MS). `serve` polls fast so live
   *  agent titles propagate — refreshMeta must then be cheap per call. The
   *  room only sees a message when the meta actually changed. */
  metaRefreshMs?: number;
  /** Daemon plugins: tunneled routes under /__codehost/<name>/ (their meta
   *  contributions are the caller's job, inside `meta`/`refreshMeta`). */
  plugins?: DaemonPlugin[];
  /** Files whose change should trigger an immediate `refreshMeta` (e.g. the
   *  host workspace registry). Watched via their parent directory so the file
   *  may not exist yet. */
  watchFiles?: string[];
}

/** How often a daemon re-enumerates its workspaces (manual clones show up). */
const META_REFRESH_MS = 60_000;

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

  // Re-advertise when the workspace set changes (provision, manual clone).
  let lastMeta = JSON.stringify(opts.meta);
  const refreshMeta = () => {
    if (!opts.refreshMeta) return;
    const meta = opts.refreshMeta();
    const s = JSON.stringify(meta);
    if (s === lastMeta) return;
    lastMeta = s;
    client.updateMeta(meta);
  };
  const provision: ProvisionDeps | undefined = opts.provision
    ? { ...opts.provision, onProvisioned: refreshMeta }
    : undefined;
  const plugins = opts.plugins ?? [];
  const onLocal =
    provision || plugins.length > 0
      ? (req: LocalRequest) => {
          if (provision && isProvisionPath(req.path)) return handleProvision(req.path, provision);
          return routePlugins(plugins, req);
        }
      : undefined;

  rtc = new RtcDaemon({
    sendSignal: (to, data) => client.sendSignal(to, data),
    onChannel: (viewerId, channel) => {
      console.log(`[codehost] viewer ${viewerId.slice(0, 8)} connected; bridging to :${target.port}`);
      new Tunnel(channel, target.port, target.stripBasePath, onLocal);
    },
  });

  client.connect();
  if (opts.refreshMeta) {
    setInterval(refreshMeta, opts.metaRefreshMs ?? META_REFRESH_MS);
    // Near-instant re-advertise when a watched file changes. Throttled, not
    // debounced: fs.watch fires in bursts, but a file that changes CONSTANTLY
    // (a busy registry) would keep resetting a debounce forever — a trailing
    // throttle guarantees a refresh at most/at least every 300ms.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const requestRefresh = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        refreshMeta();
      }, 300);
    };
    for (const file of opts.watchFiles ?? []) {
      try {
        watch(dirname(file), (_event, filename) => {
          if (filename && filename !== basename(file)) return;
          requestRefresh();
        });
      } catch {
        // missing dir / unsupported platform — the interval still covers it
      }
    }
  }

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
