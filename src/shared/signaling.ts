// Signaling protocol shared by the browser, the CLI daemon, and the Cloudflare
// Worker / Durable Object. A "room" is keyed by the user's token; every member
// of a room can see the others and exchange WebRTC SDP/ICE via the relay.

/**
 * Room roles. A connecting browser is a "client"; "viewer" is the legacy wire
 * value for the same role, kept so older daemons/pages still interop (the term
 * understated the access — a connected client gets the host's full VS Code:
 * terminal + file write). Backward-compat plan ("accept both, emit old"):
 * receivers treat client and viewer alike via `isClientRole`, and new code
 * still EMITS the legacy `CLIENT_WIRE_ROLE` ("viewer") until daemons have rolled
 * forward; a later release flips the emit to "client".
 */
export type Role = "server" | "client" | "viewer";

/** The connecting-role value new code emits. Still the legacy "viewer" during
 *  the accept-both transition; flip to "client" once daemons recognize it. */
export const CLIENT_WIRE_ROLE: Role = "viewer";

/** True for either spelling of the connecting (browser) role. Use everywhere a
 *  receiver decides "is this peer a client" so both old and new peers match. */
export function isClientRole(role: Role): boolean {
  return role === "client" || role === "viewer";
}

/** One live agent CLI session on the daemon's machine (sourced from agent-yes's
 *  registry) — advertised so clients can see which agents run where. Interact
 *  with it over the tunnel's `/__codehost/agent-yes/*` proxy. */
export interface AgentInfo {
  pid: number;
  /** CLI the agent runs, e.g. "claude", "codex". */
  tool: string;
  /** Prompt/note snippet for display. */
  title?: string;
  /** Working directory (?folder= form) — ties an agent to a workspace. */
  cwd: string;
  state: "active" | "idle";
  /** Unix ms when the agent started. */
  startedAt?: number;
}

/** One checkout a root daemon found on disk under its layout — advertised so
 *  clients can list and exactly match real workspaces instead of synthesizing
 *  optimistic paths. */
export interface WorkspaceInfo {
  /** ?folder= form path of the checkout (see toPosixPath). */
  path: string;
  /** Host-agnostic repo identity, e.g. "github.com/owner/repo". */
  repo?: string;
  /** Branch from the layout path, e.g. "main". */
  branch?: string;
  /** This entry is the daemon's `.codehost/` config dir (setup.sh etc.), not a
   *  repo checkout — clients render it as a settings affordance, openable in
   *  the editor like any workspace. */
  config?: boolean;
}

/**
 * Metadata a room member advertises. Servers (`codehost serve`/`dev`) fill the
 * workspace fields; a client (the codehost.dev page) sends just `name` as its
 * roster label and leaves the server-only fields unset — hence everything but
 * `name` is optional.
 */
export interface PeerMeta {
  /** Human label. Server: defaults to hostname. Client: a browser/OS label. */
  name: string;
  /** Server only: directory the VS Code instance is serving (repo dir or root). */
  cwd?: string;
  /** Server only: hostname of the machine running the daemon. */
  host?: string;
  /**
   * Stable machine identity (UUID persisted in ~/.codehost/config.json). All
   * daemons on one machine share it, unlike the per-process peerId, so clients
   * can group peers by host and keep history across daemon restarts. Absent on
   * older daemons — fall back to `host`.
   */
  hostId?: string;
  /**
   * "repo": serves a single folder (`codehost dev`), git-identified when possible.
   * "root": serves a workspace root (`codehost serve`) whose repos live under it.
   * Absent is treated as "repo" for backward compatibility.
   */
  kind?: "repo" | "root";
  /** repo kind: host-agnostic identity, e.g. "github.com/snomiao/codehost". */
  repo?: string;
  /** repo kind: current branch, e.g. "main". */
  branch?: string;
  /**
   * root kind: on-disk layout of repos under `cwd`, as a template filled from a
   * deep link — default "{owner}/{repo}/tree/{branch}". The opened folder is
   * `cwd + "/" + fill(layout, target)`.
   */
  layout?: string;
  /**
   * root kind: the checkouts that actually exist under `cwd` (enumerated on
   * start, after each provision, and on a slow rescan). Capped server-side;
   * absent on older daemons and on repo/expose kinds.
   */
  workspaces?: WorkspaceInfo[];
  /**
   * Live agent CLI sessions on this machine (from the agent-yes plugin).
   * Advertised by root daemons; capped server-side.
   */
  agents?: AgentInfo[];
}

export interface PeerInfo {
  peerId: string;
  role: Role;
  meta: PeerMeta | null;
  /** Worker-stamped join time (ms). Compare against `PeersMessage.now`, which
   *  is on the same clock, for a roster "connected N ago" without clock skew.
   *  Absent from older workers. */
  since?: number;
}

// ---- Client -> Server ----

/** First message after connecting: identify role + (for servers) metadata. */
export interface HelloMessage {
  type: "hello";
  role: Role;
  peerId: string;
  meta?: PeerMeta;
}

/** Relay a WebRTC signal (offer / answer / ICE candidate) to another peer. */
export interface SignalMessage {
  type: "signal";
  to: string;
  /** Opaque payload: { sdp } or { candidate }. */
  data: unknown;
}

/** Liveness heartbeat. The room evicts members that stop sending these, so a
 *  hard-killed daemon (whose WebSocket lingers until the edge times it out)
 *  doesn't haunt the peer list as a dead server. */
export interface PingMessage {
  type: "ping";
}

/** Replace this peer's advertised metadata mid-session (e.g. a provision
 *  created a new workspace) — the room re-broadcasts the peer list. Older
 *  workers ignore it; the meta still lands via `hello` on the next reconnect. */
export interface MetaMessage {
  type: "meta";
  meta: PeerMeta;
}

export type ClientMessage = HelloMessage | SignalMessage | PingMessage | MetaMessage;

// ---- Server -> Client ----

/** Confirms connection and echoes the assigned peerId. */
export interface WelcomeMessage {
  type: "welcome";
  peerId: string;
}

/** Current room membership; sent on join and whenever it changes. */
export interface PeersMessage {
  type: "peers";
  peers: PeerInfo[];
  /** Worker wall-clock (ms) at send time — same clock as `PeerInfo.since`, so a
   *  client renders relative join ages without trusting its own clock. Absent
   *  from older workers. */
  now?: number;
}

/** A signal relayed from another peer. */
export interface RelayedSignalMessage {
  type: "signal";
  from: string;
  data: unknown;
}

export type ServerMessage = WelcomeMessage | PeersMessage | RelayedSignalMessage;

export function newPeerId(): string {
  return crypto.randomUUID();
}
