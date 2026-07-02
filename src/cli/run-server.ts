import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type PeerMeta, isClientRole, newPeerId } from "../shared/signaling";
import { SignalingClient } from "../shared/signaling-client";
import { Approver, type ApprovePolicy } from "./approver";
import { RtcDaemon } from "./rtc-daemon";
import { type LocalRequest, Tunnel } from "./tunnel";
import {
  handleProvision,
  handleProvisionConfig,
  isProvisionConfigPath,
  isProvisionPath,
  type ProvisionConfigDeps,
  type ProvisionDeps,
} from "./provision-server";
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
  /** Client admission policy (default "auto"). */
  approve?: ApprovePolicy;
  /** Label substrings auto-approved under the "confirm" policy. */
  allow?: string[];
}

/** How often a daemon re-enumerates its workspaces (manual clones show up). */
const META_REFRESH_MS = 60_000;

/** Floor between meta pushes to the room. `serve` re-evaluates meta every ~3s so
 *  live agent titles stay fresh, but each push is a billable DO request that
 *  fans out to every peer — so coalesce bursts (a churning agent title) into at
 *  most one push per this interval. The first change in a quiet period goes out
 *  immediately; rapid follow-ups ride a single trailing push. */
const MIN_META_PUSH_MS = 15_000;

/**
 * Foreground server loop shared by `serve`, `dev`, and `expose`: register in the
 * signaling room with the given meta and bridge each client's data channel to a
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

  // Track client labels from the room roster so approval prompts and the bridge
  // log name *who* connected (a leaked-token tell), not just an opaque peerId.
  const clientNames = new Map<string, string>();
  const labelFor = (clientId: string) => clientNames.get(clientId) ?? "unknown client";

  const approver = new Approver({
    policy: opts.approve ?? "auto",
    allow: opts.allow ?? [],
    kick: (clientId) => {
      // Tell the client why it's being cut off, then tear down the connection.
      client.sendSignal(clientId, { kind: "denied" });
      rtc.close(clientId);
    },
    notifyPending: (clientId) => client.sendSignal(clientId, { kind: "pending" }),
  });

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
    onPeers: (peers) => {
      clientNames.clear();
      for (const p of peers) {
        if (isClientRole(p.role) && p.meta?.name) clientNames.set(p.peerId, p.meta.name);
      }
    },
    onSignal: (from, data) => rtc.handleSignal(from, data),
  });

  // Re-advertise when the workspace set changes (provision, manual clone),
  // throttled so a burst of changes is at most one room push per MIN_META_PUSH_MS.
  let sentMeta = JSON.stringify(opts.meta); // last meta the room actually has
  let lastPushAt = 0; // ms of the last updateMeta send (0 = none since connect)
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const sendMeta = (meta: PeerMeta) => {
    const s = JSON.stringify(meta);
    if (s === sentMeta) return; // nothing new since the last push
    sentMeta = s;
    lastPushAt = Date.now();
    client.updateMeta(meta);
  };
  const refreshMeta = () => {
    if (!opts.refreshMeta) return;
    const meta = opts.refreshMeta();
    if (JSON.stringify(meta) === sentMeta) return; // unchanged — nothing to do
    const wait = MIN_META_PUSH_MS - (Date.now() - lastPushAt);
    if (wait <= 0) {
      // Cooldown elapsed: push the leading change now, dropping any pending one.
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = null;
      sendMeta(meta);
    } else if (!pushTimer) {
      // Within the cooldown: schedule one trailing push that re-reads the
      // freshest meta when it fires, so coalesced changes all ship at once.
      pushTimer = setTimeout(() => {
        pushTimer = null;
        sendMeta(opts.refreshMeta!());
      }, wait);
    }
  };
  const provision: ProvisionDeps | undefined = opts.provision
    ? { ...opts.provision, token: opts.token, onProvisioned: refreshMeta }
    : undefined;
  const provisionConfig: ProvisionConfigDeps | undefined = opts.provision
    ? { homeDir: opts.provision.homeDir, onSaved: refreshMeta }
    : undefined;
  const plugins = opts.plugins ?? [];
  const onLocal =
    provision || provisionConfig || plugins.length > 0
      ? (req: LocalRequest) => {
          if (provision && isProvisionPath(req.path)) return handleProvision(req.path, provision);
          if (provisionConfig && isProvisionConfigPath(req.path)) return handleProvisionConfig(req, provisionConfig);
          return routePlugins(plugins, req);
        }
      : undefined;

  // A client opens two data channels (interactive + bulk), so onChannel fires
  // twice per connection — log/register "connected" only on the first.
  const bridged = new Set<string>();
  rtc = new RtcDaemon({
    sendSignal: (to, data) => client.sendSignal(to, data),
    admit: (clientId) => approver.admit(clientId, labelFor(clientId)),
    onChannel: (clientId, channel) => {
      if (!bridged.has(clientId)) {
        bridged.add(clientId);
        const who = labelFor(clientId);
        console.log(`[codehost] ${who} (${clientId.slice(0, 8)}) connected; bridging to :${target.port}`);
        approver.onConnected(clientId, who);
      }
      new Tunnel(channel, target.port, target.stripBasePath, onLocal);
    },
    onClose: (clientId) => {
      bridged.delete(clientId);
      approver.onDisconnected(clientId);
    },
  });

  approver.banner();
  approver.start();

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
    approver.stop();
    rtc.closeAll();
    client.close();
    target.stop?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<never>(() => {});
}
