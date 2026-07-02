import { useEffect, useRef, useState } from "react";
import { type AgentInfo, type PeerInfo, type WorkspaceInfo, CLIENT_WIRE_ROLE, isClientRole } from "../shared/signaling";
import { TOKEN_REQUIREMENTS, validateToken } from "../shared/token";
import { SignalingClient } from "../shared/signaling-client";
import type { RtcSignal } from "../shared/rtc";
import { RtcClient } from "./rtc-client";
import { getSignalUrl } from "./config";
import { registerTunnelHost } from "./tunnel-host";
import { connBroker } from "./conn-broker";
import {
  DEFAULT_BRANCH,
  type DeepLink,
  type RepoTarget,
  type ResolvePrefs,
  type RoomMatch,
  gitUrlToPath,
  parseDeepLink,
  pickRoomMatch,
  repoKey,
  resolveDevTarget,
  resolveHostTarget,
  resolveRepoTarget,
  shareableDeepLink,
} from "../shared/repo";
import { getRooms, historyFor, recordConnection, setRooms } from "./history";
import { deriveTags, matchQuery, shortRoomLabel, tagKey } from "../shared/tags";

const TOKEN_KEY = "codehost.token";

type ConnState = "idle" | "connecting" | "pending" | "provisioning" | "connected" | "failed" | "denied";

/** What to do once `connectTo`'s RTC handshake finishes: run provisioning then
 *  open the iframe (repo deep link), or fetch this host's provisioning files
 *  and render the settings view (bare /host/<hostname> deep link). Undefined
 *  just opens the iframe on the resolved/current folder. */
type PostConnect = { kind: "repo"; target: RepoTarget } | { kind: "hostSettings"; host: string } | undefined;

/** `connectTo`'s post-connect action for a parsed deep link. */
function postConnectFor(dl: DeepLink): PostConnect {
  if (dl?.type === "repo") return { kind: "repo", target: dl.target };
  if (dl?.type === "hostSettings") return { kind: "hostSettings", host: dl.host };
  return undefined;
}

type SetupScriptName = "setup.sh" | "setup.bat" | "setup.ps1";

/** A host's fetched `.codehost/config.yaml` + setup script, and the in-progress
 *  edit/save state for the settings view (`GET`/`PUT /__codehost/provision-config`). */
type HostSettingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      configYaml: string;
      configYamlExists: boolean;
      setupScript: string;
      setupScriptName: SetupScriptName;
      setupScriptExists: boolean;
      configYamlDraft: string;
      setupScriptDraft: string;
      saving: boolean;
      saveError: string | null;
      savedAt: number | null;
    };

/** A server discovered in a specific room (its token routes the signaling). */
type RoomedServer = { server: PeerInfo; room: string };

/**
 * A short "Browser · OS" label this page advertises in the room roster, so the
 * host and other clients can tell devices apart (and spot a stranger that
 * shouldn't have the token). Best-effort UA sniff; falls back to "browser".
 */
function clientLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "browser";
  const os = /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /(iPhone|iPad|iPod)/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} · ${os}` : browser;
}

/** Coarse "Ns/Nm/Nh" from a worker-clock join time and the room's clock. */
function relTime(since?: number, now?: number): string | null {
  if (!since || !now) return null;
  const secs = Math.max(0, Math.round((now - since) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

/**
 * Read a room token handed in the URL fragment as `#t=<token>` (what the CLI
 * prints/opens after `setup`/`serve`). The page is static, so the fragment
 * never reaches the server — a safe place for the shared secret. Everything
 * after `#t=` is the token (URL-encoded by the CLI); returns "" if absent.
 */
function tokenFromHash(): string {
  const m = window.location.hash.match(/^#t=(.+)$/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

/** Short label for the "looking for…" state from a deep link. */
function deepLinkLabel(dl: DeepLink): string | null {
  if (!dl) return null;
  if (dl.type === "repo") return `${dl.target.owner}/${dl.target.name}`;
  if (dl.type === "hostSettings") return `${dl.host} settings`;
  return dl.target.host ? `${dl.target.host}:${dl.target.path}` : dl.target.path;
}

function folderQuery(folder?: string): string {
  return folder ? `?folder=${encodeURIComponent(folder)}` : "";
}

/** Human label for a connected workspace: its GitHub-style URL when the share
 *  path is repo-shaped (/gh/owner/repo -> github.com/owner/repo, /git/<host>/…
 *  -> <host>/…), else the deep-link path as-is. */
function shareLabel(path: string | null): string | null {
  if (!path) return null;
  const gh = path.match(/^\/gh\/(.+)$/);
  if (gh) return `github.com/${gh[1]}`;
  const git = path.match(/^\/git\/(.+)$/);
  if (git) return git[1];
  return path;
}

/** External URL for a repo-shaped share path, so the connected-view label can
 *  link out to the real host: /gh/owner/repo/tree/x -> https://github.com/owner/repo/tree/x,
 *  /git/<host>/… -> https://<host>/… . Null for non-repo paths (folder mounts),
 *  which have no public URL. */
function shareHref(path: string | null): string | null {
  if (!path) return null;
  const gh = path.match(/^\/gh\/(.+)$/);
  if (gh) return `https://github.com/${gh[1]}`;
  const git = path.match(/^\/git\/(.+)$/);
  if (git) return `https://${git[1]}`;
  return null;
}

/**
 * Find which of the user's saved rooms hosts a server matching a token-less deep
 * link. Opens a short-lived viewer connection to each candidate room in
 * parallel. An *exact* match (a server that truly serves this workspace) wins
 * immediately; *root-fallback* matches (any room with a root daemon, which
 * `resolveRepoTarget` returns for ANY repo link) are only chosen at the timeout,
 * via `pickRoomMatch`, so an unrelated room with a root server can't steal the
 * link. Resolves to the winning room's token (or null on no match). All temp
 * clients are closed.
 */
function findRoomForDeepLink(dl: DeepLink, tokens: string[], timeoutMs = 6000): Promise<string | null> {
  if (!dl || tokens.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const clients: SignalingClient[] = [];
    const fallbacks: RoomMatch[] = [];
    let done = false;
    const finish = (tok: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clients.forEach((c) => c.close());
      resolve(tok);
    };
    const timer = setTimeout(() => finish(pickRoomMatch(fallbacks)?.token ?? null), timeoutMs);
    for (const tok of tokens) {
      const client = new SignalingClient({
        url: getSignalUrl(),
        token: tok,
        role: CLIENT_WIRE_ROLE,
        onPeers: (peers) => {
          const servers = peers.filter((p) => p.role === "server");
          const res =
            dl.type === "repo" ? resolveRepoTarget(servers, dl.target)
            : dl.type === "hostSettings" ? resolveHostTarget(servers, dl.host)
            : resolveDevTarget(servers, dl.target);
          if (!res) return;
          if (!res.folder || res.exact) finish(tok); // exact match — take it now
          else if (!fallbacks.some((f) => f.token === tok)) fallbacks.push({ token: tok, resolution: res });
        },
      });
      clients.push(client);
      client.connect();
    }
  });
}

/**
 * Headless per-room signaling client — one instance per joined room. React's
 * keyed reconciliation (`key={token}`) adds/removes these as the joined set
 * changes, so joining or leaving a room never tears down the other rooms' live
 * discovery (or the active WebRTC session). Renders nothing: it pushes its
 * room's servers/open-state up to the parent and registers a signal sender so
 * the parent can dial peers found in this room.
 */
function RoomClient(props: {
  token: string;
  label: string;
  onPeers: (peers: PeerInfo[]) => void;
  onRoster: (clients: PeerInfo[], now?: number) => void;
  onStatus: (open: boolean) => void;
  onSignal: (from: string, data: unknown) => void;
  registerSender: (send: ((to: string, data: unknown) => void) | null) => void;
}) {
  // Keep the latest callbacks in a ref so the socket effect runs once per token,
  // not on every parent re-render (which would needlessly churn the WebSocket).
  const cb = useRef(props);
  cb.current = props;
  const { token, label } = props;
  useEffect(() => {
    const client = new SignalingClient({
      url: getSignalUrl(),
      token,
      // Connecting role. CLIENT_WIRE_ROLE is still the legacy "viewer" during the
      // accept-both transition; servers match it via isClientRole either way.
      role: CLIENT_WIRE_ROLE,
      // Advertise a label so this tab shows up named in the room roster.
      meta: { name: label },
      onOpen: () => cb.current.onStatus(true),
      onClose: () => cb.current.onStatus(false),
      onPeers: (peers, now) => {
        cb.current.onPeers(peers.filter((p) => p.role === "server"));
        // Other clients in the room (not us) — surfaced as the roster.
        cb.current.onRoster(peers.filter((p) => isClientRole(p.role) && p.peerId !== client.peerId), now);
      },
      onSignal: (from, data) => cb.current.onSignal(from, data),
    });
    cb.current.registerSender((to, data) => client.sendSignal(to, data));
    client.connect();
    return () => {
      client.close();
      cb.current.registerSender(null);
    };
  }, [token]);
  return null;
}

/** Track a `(max-width: …)` media query so inline-styled components can go
 *  responsive without a stylesheet. SSR-safe and listener-cleaned. */
function useNarrow(maxWidth = 560): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width:${maxWidth}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${maxWidth}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [maxWidth]);
  return narrow;
}

/** A copy-to-clipboard command row: label, the command, and a Copy button. On
 *  narrow screens the three stack vertically so the long command doesn't get
 *  crushed between a fixed label and the button. */
function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const narrow = useNarrow();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // clipboard blocked (insecure context / permission) — fall back to prompt
      window.prompt("Copy this command:", command);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ ...styles.cmdRow, ...(narrow ? styles.cmdRowNarrow : null) }}>
      <span style={{ ...styles.cmdLabel, ...(narrow ? styles.cmdLabelNarrow : null) }}>{label}</span>
      <code style={styles.cmdCode}>{command}</code>
      <button style={{ ...styles.cmdCopy, ...(narrow ? styles.cmdCopyNarrow : null) }} onClick={copy}>
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

/**
 * "Set up a machine" card: the one-liner that turns any machine into a codehost
 * server. The script bootstraps everything (Bun, the CLI, VS Code, the daemon),
 * so the user needs no prerequisites — not even Bun. setup.sh/.ps1 are aliases
 * of install.* served by Pages (see public/_redirects).
 */
function SetupCard() {
  return (
    <div style={styles.setupCard}>
      <div style={styles.setupHead}>Set up a machine</div>
      <p style={styles.setupSub}>
        Run this on a machine to serve it here. It installs everything — Bun, VS Code, and the
        codehost daemon — no prerequisites, and it picks a token and opens the browser for you.
      </p>
      <CopyCommand label="macOS / Linux" command="curl -fsSL https://codehost.dev/setup.sh | sh" />
      <CopyCommand label="Windows" command={'powershell -c "irm codehost.dev/setup.ps1 | iex"'} />
    </div>
  );
}

export function Discovery() {
  // Joined rooms — each token *is* a room id, and we keep one live signaling
  // client per room (see RoomClient). Seeded from the persisted room list plus
  // any legacy single-token / URL-fragment token, then format-validated.
  const [tokens, setTokens] = useState<string[]>(() => {
    const seed = new Set<string>(getRooms());
    const legacy = localStorage.getItem(TOKEN_KEY);
    if (legacy) seed.add(legacy);
    const fromHash = tokenFromHash();
    if (fromHash) seed.add(fromHash);
    return [...seed].filter((t) => validateToken(t).ok);
  });

  // Per-room discovery state, merged into one workspace list below.
  const [serversByRoom, setServersByRoom] = useState<Record<string, PeerInfo[]>>({});
  const [roomOpen, setRoomOpen] = useState<Record<string, boolean>>({});
  // Other clients (browsers) per room, for the "In this room" roster, plus the
  // worker clock from the latest peers message for relative join times.
  const [clientsByRoom, setClientsByRoom] = useState<Record<string, PeerInfo[]>>({});
  const [roomNow, setRoomNow] = useState<number | undefined>(undefined);
  // This tab's roster label, computed once.
  const labelRef = useRef(clientLabel());

  // Token input = "join another room": validated, then appended to the set.
  // Never pre-filled with a saved token — it's a bearer secret.
  const [draft, setDraft] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // "Open a GitHub repo" box: paste a github.com URL -> navigate to its /gh/
  // deep link, which resolves/opens (and, once provisioning lands, materializes)
  // the workspace.
  const [ghUrl, setGhUrl] = useState("");
  const [ghError, setGhError] = useState<string | null>(null);

  // Fake-tag filter over the merged workspace list: a free-text box plus a set
  // of pinned tag tokens (chips). Both feed the same `ay ls`-style AND matcher.
  const [filter, setFilter] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);

  // One WebRTC session at a time (you view a single VS Code), discovered across
  // many rooms. `activeRoomRef` is the room the active peer was found in: its
  // client carries the peer's signaling and it's the token Share/history record.
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnState>("idle");
  // ICE path of the live session ("lan" | "p2p"); null when unknown or when
  // this tab rides another tab's connection via the broker.
  const [connPath, setConnPath] = useState<"lan" | "p2p" | null>(null);
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  // Streamed setup.sh output shown while connState === "provisioning".
  const [provisionLog, setProvisionLog] = useState("");

  // Host-settings view: set once connectTo resolves a `hostSettings` deep
  // link, instead of an iframe. `hostSettings` holds the fetched/edited
  // .codehost/config.yaml + setup script for `settingsHost`.
  const [settingsHost, setSettingsHost] = useState<string | null>(null);
  const [hostSettings, setHostSettings] = useState<HostSettingsState | null>(null);
  // #provisioning is the only tab today; read once and kept in the URL (not
  // stripped like #t=) so the convention supports more tabs later.
  const [settingsTab, setSettingsTab] = useState<string>(() => window.location.hash.slice(1) || "provisioning");

  const rtcRef = useRef<RtcClient | null>(null);
  const activePeerRef = useRef<string | null>(null);
  const activeRoomRef = useRef<string | null>(null);
  const sendersRef = useRef<Map<string, (to: string, data: unknown) => void>>(new Map());
  // Admission control: the host can hold ("pending") or reject ("denied") us.
  // `deniedRef` stops a trailing pc state change from overwriting the denied UI;
  // the timer/reject refs let a control signal extend or abort the dial attempt.
  const deniedRef = useRef(false);
  const dialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialRejectRef = useRef<((e: Error) => void) | null>(null);
  // Whether the live connection pushed a history entry (so Disconnect/Back can
  // pop it back to the list).
  const pushedRef = useRef(false);
  // A dial is in flight — a synchronous guard so the several reconnect triggers
  // (popstate, server-list change, retry timer, deep-link auto-connect) never
  // double-dial (connState updates a render too late to gate them).
  const dialingRef = useRef(false);
  // Set just before a failed-dial history.back() so the resulting popstate is
  // treated as a URL revert, not a user navigation — the reconciler skips it once.
  const revertingRef = useRef(false);
  // Latest merged server list + connection state, read by the URL reconciler
  // (invoked from the once-at-mount popstate handler) without a stale closure.
  const allServersRef = useRef<RoomedServer[]>([]);
  const connStateRef = useRef<ConnState>("idle");

  // Deep-link resolution (/gh/<owner>/<repo>/... or /dev/<path>): parse once,
  // auto-connect when a matching server appears, remember the opened folder.
  const deepLinkRef = useRef<DeepLink>(parseDeepLink(window.location.pathname));
  const resolvedRef = useRef(false);
  // A valid token in the URL fragment enables single-server auto-connect, scoped
  // to *that* room so unrelated joined rooms don't block it.
  const autoConnectRef = useRef(false);
  const hashRoomRef = useRef<string | null>(null);
  const activeFolderRef = useRef<string | undefined>(undefined);
  const [resolving, setResolving] = useState<string | null>(() => deepLinkLabel(deepLinkRef.current));

  // Shareable deep-link pathname for the live connection (drives the address bar
  // and the Share button); transient "copied" flag for the button.
  const sharePathRef = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);

  function adoptRoom(t: string) {
    setTokens((prev) => (prev.includes(t) ? prev : [...prev, t]));
  }

  // Persist the joined set so rooms survive reloads.
  useEffect(() => {
    setRooms(tokens);
  }, [tokens]);

  // Register the Service Worker + connection broker once. The broker shares one
  // WebRTC connection per server across tabs; on owner failover it asks us to
  // reload the iframe so it reconnects through the new owner.
  useEffect(() => {
    void registerTunnelHost();
    connBroker.onLost((peerId) => {
      if (peerId !== activePeerRef.current) return;
      setIframeSrc(null);
      const folder = activeFolderRef.current;
      setTimeout(() => setIframeSrc(`/vs/${peerId}/${folderQuery(folder)}`), 400);
    });
    // Back/Forward (Cmd+Left / Cmd+Right) reconcile the connection to the URL: a
    // workspace deep link (re)connects to its server, the list URL drops the
    // connection. The browser already changed the URL; we follow it. A failed
    // dial's revert-back is skipped once (revertingRef) so it keeps the list.
    const onPopState = () => {
      if (revertingRef.current) {
        revertingRef.current = false;
        return;
      }
      syncToUrl();
    };
    window.addEventListener("popstate", onPopState);
    // Only #provisioning exists today, but keep settingsTab in sync with the
    // hash so a second tab later just needs a new render case, no new plumbing.
    const onHashChange = () => setSettingsTab(window.location.hash.slice(1) || "provisioning");
    window.addEventListener("hashchange", onHashChange);
    // A valid token in the URL fragment (#t=<token>) joins the room and turns on
    // single-server auto-connect for it; consume it from the address bar after,
    // so the secret isn't left visible or re-applied on a manual reload.
    const urlToken = tokenFromHash();
    if (urlToken && validateToken(urlToken).ok) {
      autoConnectRef.current = true;
      hashRoomRef.current = urlToken;
      if (window.location.hash) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }

    // Resolve a token-less deep link to a room: first the room that last served
    // this repo, otherwise search all saved rooms for a live server that hosts
    // this workspace and adopt it. Skipped when the link already carries a token.
    const dl = deepLinkRef.current;
    if (dl && !(urlToken && validateToken(urlToken).ok)) {
      const histToken = dl.type === "repo" ? historyFor(repoKey(dl.target))?.token : undefined;
      if (histToken) {
        adoptRoom(histToken);
      } else {
        const rooms = getRooms();
        if (rooms.length) {
          void findRoomForDeepLink(dl, rooms).then((tok) => {
            if (tok) adoptRoom(tok);
          });
        }
      }
    }

    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  // Auto-connect once discovery turns up a match: a deep-link target across any
  // room, or the lone server of a room joined via #t=.
  useEffect(() => {
    if (resolvedRef.current) return;
    tryAutoConnect();
  }, [serversByRoom, tokens]);

  // Mirror the open workspace into the tab title (GitHub-style URL), so tabs
  // read as "github.com/owner/repo/tree/main — codehost", not all "Codehost".
  useEffect(() => {
    const label = connState === "connected" ? shareLabel(sharePathRef.current) : null;
    document.title = label ? `${label} — codehost` : "Codehost";
  }, [connState]);

  // Keep the connection in sync with the URL as servers come and go: reconnect
  // when the workspace named by the address bar (re)appears in a room — covers a
  // daemon restart or a dropped channel while the tab stays open.
  useEffect(() => {
    syncToUrl();
  }, [serversByRoom]);

  // Safety-net retry: while the URL names a workspace we're not connected to and
  // no dial is in flight, retry every few seconds — covers a dropped channel
  // whose server never left the room (so no list change fires the effect above).
  useEffect(() => {
    if (!parseDeepLink(window.location.pathname)) return;
    if (connState === "connected" || connState === "connecting") return;
    const id = setInterval(() => syncToUrl(), 5000);
    return () => clearInterval(id);
  }, [connState, serversByRoom]);

  function joinFromInput(e: React.FormEvent) {
    e.preventDefault();
    const t = draft.trim();
    const check = validateToken(t);
    if (!check.ok) {
      setTokenError(check.reason ?? "invalid token");
      return;
    }
    setTokenError(null);
    adoptRoom(t);
    setDraft("");
    setEditingToken(false);
  }

  function openGithubUrl(e: React.FormEvent) {
    e.preventDefault();
    const path = gitUrlToPath(ghUrl);
    if (!path) {
      setGhError("not a recognizable git repo URL");
      return;
    }
    setGhError(null);
    setGhUrl("");
    // Navigate to the deep link and reconcile: connect if a daemon already
    // serves it (provisioning, later, will materialize it when it doesn't).
    history.pushState(null, "", path);
    setResolving(deepLinkLabel(parseDeepLink(path)));
    syncToUrl();
  }

  function leaveRoom(t: string) {
    if (activeRoomRef.current === t) disconnect();
    setTokens((prev) => prev.filter((x) => x !== t));
    setServersByRoom((m) => {
      const n = { ...m };
      delete n[t];
      return n;
    });
    setRoomOpen((m) => {
      const n = { ...m };
      delete n[t];
      return n;
    });
    sendersRef.current.delete(t);
  }

  async function connectTo(
    server: PeerInfo,
    room: string,
    folder?: string,
    fromHistory = false,
    postConnect?: PostConnect,
  ) {
    const send = sendersRef.current.get(room);
    if (!send) return;
    dialingRef.current = true; // synchronous gate against concurrent triggers
    deniedRef.current = false;
    let didPush = false;
    try {
      // Clear any prior connection's broker state first: after an RTC drop the
      // broker still holds the dead channel in `locals`, so re-dialing the same
      // peer would otherwise resolve straight to it. Also covers switching peers.
      if (activePeerRef.current) connBroker.disconnect(activePeerRef.current);

      rtcRef.current?.close();
      rtcRef.current = null;
      setIframeSrc(null);
      setSettingsHost(null);
      setHostSettings(null);
      setActivePeerId(server.peerId);
      activePeerRef.current = server.peerId;
      activeRoomRef.current = room;
      setConnState("connecting");

      // Update the address bar the instant Connect is clicked (don't wait for the
      // handshake) and push a history entry, so Back returns to the list and
      // Forward returns here. When `fromHistory`, the browser already set the URL
      // (back/forward/reconnect) — don't push again, but a prior entry exists.
      let openFolder = folder ?? server.meta?.cwd;
      if (fromHistory) {
        pushedRef.current = true;
        sharePathRef.current = window.location.pathname;
      } else {
        const targetPath = shareablePathFor(server, openFolder);
        sharePathRef.current = targetPath ?? window.location.pathname;
        if (targetPath && targetPath !== window.location.pathname) {
          if (deepLinkRef.current) {
            // Arrived via a deep link — canonicalize the URL in place (e.g. add
            // /tree/<branch>). Same destination, so replace, don't push a
            // back-to-the-list entry.
            history.replaceState(null, "", targetPath);
          } else {
            history.pushState(null, "", targetPath);
            didPush = true;
          }
        }
        pushedRef.current = didPush;
      }

      // The broker decides whether this tab owns the connection. `establish` is
      // only invoked when we're the owner (or get promoted on failover); other
      // tabs reuse the owner's channel via a proxy, so they never open WebRTC.
      const establish = () =>
        new Promise<{ channel: RTCDataChannel; bulk: RTCDataChannel | null }>((resolve, reject) => {
          const rtc = new RtcClient({
            sendSignal: (data: RtcSignal) => send(server.peerId, data),
            onState: (state) => {
              if ((state === "failed" || state === "disconnected") && !deniedRef.current) setConnState("failed");
            },
            onOpen: (channel) => {
              if (dialTimerRef.current) clearTimeout(dialTimerRef.current);
              resolve({ channel, bulk: rtc.bulkChannel });
            },
            onClose: () => setConnState((s) => (s === "connected" ? "idle" : s)),
          });
          rtcRef.current = rtc;
          dialRejectRef.current = reject;
          // Don't hang forever dialing a peer that never answers (e.g. a stale
          // server still listed in the room): fail the attempt after 15s. A
          // "pending" admission signal swaps this for a longer approval window.
          dialTimerRef.current = setTimeout(() => {
            rtc.close();
            reject(new Error("connection timed out"));
          }, 15000);
          rtc.start().catch((err) => {
            if (dialTimerRef.current) clearTimeout(dialTimerRef.current);
            reject(err);
          });
        });

      await connBroker.connect(server.peerId, establish);

      // Show which ICE path got nominated (owner tab only — a proxied tab has
      // no RTCPeerConnection of its own). ICE may re-nominate just after the
      // channel opens, so sample again shortly.
      setConnPath(null);
      // (assertion: TS narrows the ref to null from the reset above and can't
      // see that `establish` re-assigned it)
      const rtcForPath = rtcRef.current as RtcClient | null;
      if (rtcForPath) {
        const sample = () =>
          void rtcForPath.selectedPath().then((p) => {
            if (rtcRef.current === rtcForPath && p) setConnPath(p);
          });
        sample();
        setTimeout(sample, 3000);
      }

      // For a repo deep link, ask the daemon to provision (run .codehost/setup.sh
      // and hand back the authoritative workspace path) before opening. Streams
      // the log under the "provisioning" state. Daemons without the route (older
      // builds) return no path → fall back to the browser-computed folder.
      if (postConnect?.kind === "repo") {
        setConnState("provisioning");
        setProvisionLog("");
        const ws = await runProvision(server.peerId, postConnect.target);
        if (activePeerRef.current !== server.peerId) return; // cancelled/switched mid-provision
        if (ws) openFolder = ws;
      }

      // A host-settings deep link: no iframe, just fetch the provisioning
      // files over the tunnel and render the settings view below.
      if (postConnect?.kind === "hostSettings") {
        setConnState("connected");
        setResolving(null);
        setSettingsHost(postConnect.host);
        void loadHostSettings(server.peerId);
        return;
      }

      setConnState("connected");
      // The daemon no longer sets a default folder (current VS Code serve-web
      // dropped that flag), so open the served workspace from here: the
      // provisioned/deep-link folder if we have one, else the server's reported cwd.
      activeFolderRef.current = openFolder;
      setIframeSrc(`/vs/${server.peerId}/${folderQuery(openFolder)}`);
      setResolving(null);
      recordConnect(server, room, openFolder);
    } catch {
      setConnState(deniedRef.current ? "denied" : "failed");
      // Undo the optimistic history entry we pushed. revertingRef makes the
      // resulting popstate a no-op so the "failed" card stays on the list.
      if (didPush) {
        revertingRef.current = true;
        history.back();
      }
    } finally {
      dialingRef.current = false;
    }
  }

  // Ask the daemon to provision a repo workspace over the tunnel: stream
  // setup.sh's output into `provisionLog` and return the daemon-authoritative
  // path (the `x-codehost-workspace` header). Returns null when the daemon has
  // no provision route (older build) or the call fails — caller falls back.
  async function runProvision(peerId: string, t: RepoTarget): Promise<string | null> {
    const params = new URLSearchParams({
      owner: t.owner,
      repo: t.name,
      branch: t.branch ?? DEFAULT_BRANCH,
      host: t.host,
    });
    let res: Response;
    try {
      res = await connBroker.tunnelFor(peerId).fetch("GET", `/__codehost/provision?${params}`, {});
    } catch {
      return null;
    }
    const ws = res.headers.get("x-codehost-workspace");
    if (!ws) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    let buf = `[codehost] provisioning ${t.owner}/${t.name}@${t.branch ?? DEFAULT_BRANCH}…\n`;
    setProvisionLog(buf);
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // Hide the internal exit sentinel from the displayed log.
          setProvisionLog(buf.replace(/\n::codehost:exit=\d+\n?/, "\n"));
        }
      } catch {
        // stream interrupted (channel closed) — return the path anyway
      }
    }
    return ws;
  }

  // Fetch a host's `.codehost/config.yaml` + setup script over the tunnel for
  // the settings view. A missing file reads back as the daemon's default
  // scaffold template (see provision-server.ts's handleProvisionConfig).
  async function loadHostSettings(peerId: string) {
    setHostSettings({ status: "loading" });
    try {
      const res = await connBroker.tunnelFor(peerId).fetch("GET", "/__codehost/provision-config", {});
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const data = (await res.json()) as {
        configYaml: string;
        configYamlExists: boolean;
        setupScript: string;
        setupScriptName: SetupScriptName;
        setupScriptExists: boolean;
      };
      setHostSettings({
        status: "ready",
        ...data,
        configYamlDraft: data.configYaml,
        setupScriptDraft: data.setupScript,
        saving: false,
        saveError: null,
        savedAt: null,
      });
    } catch (err) {
      setHostSettings({ status: "error", message: String(err) });
    }
  }

  async function saveHostSettings() {
    if (hostSettings?.status !== "ready" || !activePeerId) return;
    setHostSettings({ ...hostSettings, saving: true, saveError: null });
    try {
      const body = new TextEncoder().encode(
        JSON.stringify({ configYaml: hostSettings.configYamlDraft, setupScript: hostSettings.setupScriptDraft }),
      );
      const res = await connBroker
        .tunnelFor(activePeerId)
        .fetch("PUT", "/__codehost/provision-config", { "content-type": "application/json" }, body);
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      setHostSettings((s) =>
        s?.status === "ready"
          ? {
              ...s,
              saving: false,
              configYaml: s.configYamlDraft,
              configYamlExists: true,
              setupScript: s.setupScriptDraft,
              setupScriptExists: true,
              savedAt: Date.now(),
            }
          : s,
      );
    } catch (err) {
      setHostSettings((s) => (s?.status === "ready" ? { ...s, saving: false, saveError: String(err) } : s));
    }
  }

  // Shareable deep-link pathname for a server+folder, with no side effects (no
  // token — Share adds that). Keeps an existing deep-link path as-is; otherwise
  // derives /gh|/git|/dev from the server's repo identity or opened folder.
  function shareablePathFor(server: PeerInfo, folder?: string): string | null {
    const dl = deepLinkRef.current;
    // A repo workspace always shows /tree/<branch> (GitHub-style, and it pins the
    // worktree in snomiao's /tree/<branch> layout). Branch source, in order: the
    // deep link's branch, the server's reported branch, else the layout default —
    // matching the worktree fillLayout actually opened.
    if (dl?.type === "repo") {
      const branch = dl.target.branch ?? server.meta?.branch ?? DEFAULT_BRANCH;
      return shareableDeepLink({ repo: repoKey(dl.target), branch });
    }
    if (server.meta?.repo) {
      return shareableDeepLink({ repo: server.meta.repo, branch: server.meta.branch ?? DEFAULT_BRANCH });
    }
    // Folder mount: keep the deep-link path as-is, else derive the host-scoped one.
    return dl ? window.location.pathname : shareableDeepLink({ folder, host: server.meta?.host });
  }

  async function shareLink() {
    const room = activeRoomRef.current;
    if (!room) return;
    const path = sharePathRef.current ?? window.location.pathname;
    const url = `${window.location.origin}${path}#t=${encodeURIComponent(room)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard blocked (insecure context / permission) — fall back to prompt
      window.prompt("Copy this share link:", url);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // The machine history says served this repo last — break resolution ties
  // toward it (stable hostId when recorded, hostname for older entries).
  function preferFor(dl: DeepLink): ResolvePrefs | undefined {
    if (dl?.type !== "repo") return undefined;
    const h = historyFor(repoKey(dl.target));
    return h ? { hostId: h.hostId, host: h.host } : undefined;
  }

  // Deep-link auto-connect: when servers arrive, pick the best match (exact repo
  // daemon, else a root daemon's subfolder) across all rooms and open it once.
  function tryAutoConnect() {
    if (resolvedRef.current) return;
    const dl = deepLinkRef.current;
    if (dl) {
      const peers = allServers.map((x) => x.server);
      const res =
        dl.type === "repo" ? resolveRepoTarget(peers, dl.target, preferFor(dl))
        : dl.type === "hostSettings" ? resolveHostTarget(peers, dl.host)
        : resolveDevTarget(peers, dl.target);
      if (!res) return;
      const match = allServers.find((x) => x.server.peerId === res.peerId);
      if (!match) return;
      resolvedRef.current = true;
      void connectTo(match.server, match.room, res.folder, false, postConnectFor(dl));
      return;
    }
    // No deep link, but a token arrived via the URL: open that room's server
    // straight away when it has exactly one. Scoped to the hash room so servers
    // in other joined rooms can't push the count past one and block it.
    const hashRoom = hashRoomRef.current;
    if (autoConnectRef.current && hashRoom) {
      const inRoom = allServers.filter((x) => x.room === hashRoom);
      if (inRoom.length === 1) {
        resolvedRef.current = true;
        void connectTo(inRoom[0].server, inRoom[0].room);
      }
    }
  }

  function recordConnect(server: PeerInfo, room: string, folder?: string) {
    const base = {
      token: room,
      hostId: server.meta?.hostId,
      kind: server.meta?.kind,
      name: server.meta?.name,
      host: server.meta?.host,
      lastConnected: Date.now(),
    };
    if (server.meta?.repo) recordConnection(server.meta.repo, { ...base, folder });
    const dl = deepLinkRef.current;
    if (dl?.type === "repo") recordConnection(repoKey(dl.target), { ...base, folder });
  }

  // Tear down the active connection and return to the workspace list. Does NOT
  // touch history — the caller (Disconnect → history.back, or a popstate from
  // Cmd+Left) owns the URL.
  function teardownConn() {
    rtcRef.current?.close();
    rtcRef.current = null;
    if (activePeerRef.current) connBroker.disconnect(activePeerRef.current);
    setIframeSrc(null);
    setConnPath(null);
    setActivePeerId(null);
    activePeerRef.current = null;
    activeRoomRef.current = null;
    setConnState("idle");
    sharePathRef.current = null;
    pushedRef.current = false;
    setSettingsHost(null);
    setHostSettings(null);
  }

  // Resolve a workspace deep-link path to a live server across all joined rooms.
  function findServerForDeepLink(dl: DeepLink): (RoomedServer & { folder?: string }) | null {
    if (!dl) return null;
    const peers = allServersRef.current.map((x) => x.server);
    const res =
      dl.type === "repo" ? resolveRepoTarget(peers, dl.target, preferFor(dl))
      : dl.type === "hostSettings" ? resolveHostTarget(peers, dl.host)
      : resolveDevTarget(peers, dl.target);
    if (!res) return null;
    const match = allServersRef.current.find((x) => x.server.peerId === res.peerId);
    return match ? { ...match, folder: res.folder } : null;
  }

  // Reconcile the live connection to the current URL. Drives Back/Forward nav and
  // auto-reconnect: a workspace deep link connects to (or reconnects to) the
  // server it resolves to; the list URL ("/") drops the connection. Reads only
  // refs/window, so it's safe to call from the once-at-mount popstate handler.
  function syncToUrl() {
    const dl = parseDeepLink(window.location.pathname);
    if (!dl) {
      if (activePeerRef.current) teardownConn();
      return;
    }
    if (dialingRef.current) return; // a dial is already in flight
    const target = findServerForDeepLink(dl);
    if (!target) return; // its server isn't present (yet) — wait for it to appear
    if (activePeerRef.current === target.server.peerId && connStateRef.current === "connected") return;
    void connectTo(target.server, target.room, target.folder, true, postConnectFor(dl));
  }

  // Open an enumerated checkout via its deep link, reusing the URL-driven
  // resolution (provisioning, history, machine preference) instead of dialing
  // the card's peer directly.
  function openWorkspace(server: PeerInfo, w: WorkspaceInfo) {
    const path = w.repo
      ? shareableDeepLink({ repo: w.repo, branch: w.branch })
      : shareableDeepLink({ folder: w.path, host: server.meta?.host });
    if (!path) return;
    history.pushState(null, "", path);
    setResolving(deepLinkLabel(parseDeepLink(path)));
    syncToUrl();
  }

  function disconnect() {
    // Mirror Cmd+Left: if connecting pushed a history entry, pop it — the
    // browser restores the previous URL and our popstate handler tears down.
    if (pushedRef.current) {
      history.back();
      return;
    }
    teardownConn();
    if (window.location.pathname !== "/") history.replaceState(null, "", "/");
  }

  // Merge every room's servers into one list, each tagged with its room so the
  // Connect button knows which client to signal through.
  const allServers: RoomedServer[] = tokens.flatMap((t) =>
    (serversByRoom[t] ?? []).map((server) => ({ server, room: t })),
  );
  // Mirror the latest merged servers + connection state into refs so the URL
  // reconciler (called from event handlers/timers) never reads a stale closure.
  allServersRef.current = allServers;
  connStateRef.current = connState;
  const serverCount = allServers.length;
  const onlineRooms = tokens.filter((t) => roomOpen[t]).length;
  const activeServer = allServers.find((x) => x.server.peerId === activePeerId)?.server;

  // Other clients (browsers) across all joined rooms, deduped by peerId — the
  // "In this room" roster, so you can spot a device that shouldn't hold a token.
  const otherClients = Object.values(clientsByRoom)
    .flat()
    .filter((c, i, all) => all.findIndex((x) => x.peerId === c.peerId) === i);

  // Annotate each server with its mnemonic fake-tags (incl. its room label), then
  // filter. The room token is hashed to a short label — never rendered raw.
  const tagged = allServers.map(({ server: s, room }) => ({
    server: s,
    room,
    name: s.meta?.name ?? s.peerId.slice(0, 8),
    tags: deriveTags(s.meta, { roomLabel: shortRoomLabel(room) }),
  }));
  const query = [...activeTags, filter].join(" ");
  const filtered = tagged.filter((t) => matchQuery({ name: t.name, tags: t.tags }, query));
  // Group workspaces by machine: the stable hostId when the daemon advertises
  // one, else the hostname string (older daemons), else the peer stands alone.
  // Agents are machine-level (advertised by the host's root daemon) — collect
  // them per group, deduped by pid across peers, each remembering its room so
  // a click can hand the agent-yes console the right token.
  type RoomedAgent = AgentInfo & { room: string };
  const hostGroups: { key: string; label: string; items: typeof filtered; agents: RoomedAgent[] }[] = [];
  for (const t of filtered) {
    const key = t.server.meta?.hostId ?? t.server.meta?.host ?? t.server.peerId;
    let group = hostGroups.find((g) => g.key === key);
    if (!group) {
      group = { key, label: t.server.meta?.host ?? t.name, items: [], agents: [] };
      hostGroups.push(group);
    }
    group.items.push(t);
    for (const a of t.server.meta?.agents ?? []) {
      if (!group.agents.some((x) => x.pid === a.pid)) group.agents.push({ ...a, room: t.room });
    }
  }
  const toggleTag = (t: string) =>
    setActiveTags((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));
  const addTag = (t: string) => setActiveTags((a) => (a.includes(t) ? a : [...a, t]));
  // Suggested chips: the most common identity/location tags across the list.
  const tagFreq = new Map<string, number>();
  for (const t of tagged) for (const tag of t.tags) tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1);
  const suggestedTags = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .filter((t) => ["host", "repo", "wt", "kind", "room"].includes(tagKey(t)))
    .slice(0, 12);

  // Headless signaling clients, one per joined room. Kept mounted across BOTH
  // views so switching into the iframe never tears down discovery/session.
  const roomClients = tokens.map((t) => (
    <RoomClient
      key={t}
      token={t}
      label={labelRef.current}
      onPeers={(peers) => setServersByRoom((m) => ({ ...m, [t]: peers }))}
      onRoster={(clients, now) => {
        setClientsByRoom((m) => ({ ...m, [t]: clients }));
        if (now) setRoomNow(now);
      }}
      onStatus={(open) => setRoomOpen((m) => ({ ...m, [t]: open }))}
      onSignal={(from, data) => {
        if (from !== activePeerRef.current) return;
        const kind = (data as { kind?: string } | null)?.kind;
        if (kind === "pending") {
          // Host is reviewing us — show "waiting" and stop the short dial timer
          // from failing the attempt while a human decides.
          setConnState("pending");
          if (dialTimerRef.current) clearTimeout(dialTimerRef.current);
          dialTimerRef.current = setTimeout(() => {
            rtcRef.current?.close();
            dialRejectRef.current?.(new Error("approval timed out"));
          }, 120000);
          return;
        }
        if (kind === "denied") {
          // Denied while dialing, or kicked after connecting — set state directly
          // so it covers both (the dial promise may already be settled).
          deniedRef.current = true;
          if (dialTimerRef.current) clearTimeout(dialTimerRef.current);
          rtcRef.current?.close();
          setIframeSrc(null);
          setConnState("denied");
          dialRejectRef.current?.(new Error("host denied the connection"));
          return;
        }
        void rtcRef.current?.handleSignal(data);
      }}
      registerSender={(send) => {
        if (send) sendersRef.current.set(t, send);
        else sendersRef.current.delete(t);
      }}
    />
  ));

  // Provisioning view: the daemon's setup.sh is running; stream its log.
  if (connState === "provisioning") {
    return (
      <>
        {roomClients}
        <div style={styles.page}>
          <header style={styles.header}>
            <span style={styles.brand}>codehost</span>
            <span style={styles.dim}>·</span>
            <span style={styles.dim}>provisioning…</span>
            <span style={{ flex: 1 }} />
            <button style={styles.connectBtn} onClick={disconnect}>
              Cancel
            </button>
          </header>
          <pre style={styles.provLog}>{provisionLog || "starting…"}</pre>
        </div>
      </>
    );
  }

  // Host settings view: view/edit .codehost/config.yaml + the setup script
  // over the tunnel, instead of an iframe. `#provisioning` is the only tab.
  if (settingsHost && connState === "connected") {
    return (
      <>
        {roomClients}
        <div style={styles.page}>
          <header style={styles.header}>
            <span style={styles.brand}>codehost</span>
            <span style={styles.hostTag}>[{settingsHost}]</span>
            <span style={styles.dim}>· settings</span>
            <span style={{ flex: 1 }} />
            <button style={styles.connectBtn} onClick={disconnect}>
              Disconnect
            </button>
          </header>
          <div style={styles.main}>
            {hostSettings?.status === "loading" && <p style={styles.dim}>loading…</p>}
            {hostSettings?.status === "error" && <p style={styles.tokenError}>{hostSettings.message}</p>}
            {hostSettings?.status === "ready" && settingsTab === "provisioning" && (
              <>
                <label style={styles.settingsLabel}>
                  config.yaml{!hostSettings.configYamlExists && " (not created yet — showing default)"}
                </label>
                <textarea
                  style={styles.settingsArea}
                  spellCheck={false}
                  value={hostSettings.configYamlDraft}
                  onChange={(e) =>
                    setHostSettings((s) => (s?.status === "ready" ? { ...s, configYamlDraft: e.target.value } : s))
                  }
                />
                <label style={styles.settingsLabel}>
                  {hostSettings.setupScriptName}
                  {!hostSettings.setupScriptExists && " (not created yet — showing default)"}
                </label>
                <textarea
                  style={styles.settingsArea}
                  spellCheck={false}
                  value={hostSettings.setupScriptDraft}
                  onChange={(e) =>
                    setHostSettings((s) => (s?.status === "ready" ? { ...s, setupScriptDraft: e.target.value } : s))
                  }
                />
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                  <button style={styles.button} onClick={saveHostSettings} disabled={hostSettings.saving}>
                    {hostSettings.saving ? "Saving…" : "Save"}
                  </button>
                  {hostSettings.saveError && <span style={styles.tokenError}>{hostSettings.saveError}</span>}
                  {hostSettings.savedAt && <span style={styles.echo}>saved</span>}
                </div>
              </>
            )}
          </div>
        </div>
      </>
    );
  }

  // Connected view: VS Code in an iframe, served over the tunnel.
  if (iframeSrc && connState === "connected") {
    return (
      <>
        {roomClients}
        <div style={styles.page}>
          <header style={styles.header}>
            <span style={styles.brand}>codehost</span>
            {activeServer?.meta?.host ? (
              // Which machine/account is actually serving this codehost.dev link.
              <span style={styles.hostTag} title="machine serving this workspace">
                [{activeServer.meta.user ? `${activeServer.meta.user}@` : ""}
                {activeServer.meta.host}]
              </span>
            ) : (
              <span style={styles.dim}>·</span>
            )}
            {shareHref(sharePathRef.current) ? (
              // Repo-shaped link: clickable out to the real host (GitHub etc.).
              <a
                style={styles.cwdLink}
                href={shareHref(sharePathRef.current) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                title={shareHref(sharePathRef.current) ?? undefined}
              >
                {shareLabel(sharePathRef.current)}
              </a>
            ) : (
              <span
                style={styles.cwd}
                title={`${activeServer?.meta?.name ?? ""} ${activeServer?.meta?.cwd ?? ""}`.trim()}
              >
                {shareLabel(sharePathRef.current) ??
                  activeServer?.meta?.cwd ??
                  activeServer?.meta?.name ??
                  activePeerId?.slice(0, 8)}
              </span>
            )}
            {connPath && (
              <span
                style={styles.dim}
                title={
                  connPath === "lan"
                    ? "direct LAN path — both ends on the same network"
                    : "direct peer-to-peer path (NAT traversed)"
                }
              >
                {connPath === "lan" ? "⚡LAN" : "🌐p2p"}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              style={styles.shareBtn}
              onClick={shareLink}
              title="Copy a link that opens this workspace (includes the room token)"
            >
              {copied ? "Copied!" : "Share"}
            </button>
            <button style={styles.connectBtn} onClick={disconnect}>
              Disconnect
            </button>
          </header>
          <iframe title="VS Code" src={iframeSrc} style={{ flex: 1, border: "none", width: "100%", background: "var(--ch-bg-code)" }} />
        </div>
      </>
    );
  }

  return (
    <>
      {roomClients}
      <div style={styles.page}>
        <header style={styles.header}>
          <span style={styles.brand}>codehost</span>
          <span style={styles.dim}>·</span>
          <span style={styles.dim}>{getSignalUrl()}</span>
          <span style={{ flex: 1 }} />
          <span style={{ ...styles.status, color: onlineRooms > 0 ? "var(--ch-accent-teal)" : "var(--ch-text-dim)" }}>
            {tokens.length === 0
              ? "○ no rooms"
              : `${onlineRooms > 0 ? "●" : "○"} ${onlineRooms}/${tokens.length} rooms`}
          </span>
        </header>

        <main style={styles.main}>
          {/* Inputs stay at a readable measure; the workspace grid below uses
              the full width. */}
          <div style={styles.controls}>
          {resolving && (
            <p style={{ color: "var(--ch-accent-amber)", marginBottom: 12 }}>
              Looking for <code style={styles.code}>{resolving}</code> in your rooms…{" "}
              {tokens.length > 0 ? "waiting for a live server" : "join the room's token below"}.
            </p>
          )}

          <div style={styles.tokenForm}>
            <label style={styles.label}>Rooms</label>
            {tokens.length > 0 ? (
              <>
                <div style={styles.roomChips}>
                  {tokens.map((t) => (
                    <span
                      key={t}
                      style={{ ...styles.chip, ...styles.roomChip, ...(roomOpen[t] ? styles.roomChipOn : {}) }}
                      title={roomOpen[t] ? "connected" : "connecting…"}
                    >
                      {shortRoomLabel(t)}
                      <button type="button" style={styles.roomChipX} onClick={() => leaveRoom(t)} title="leave room">
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <span style={{ flex: 1 }} />
                {!editingToken && (
                  <button
                    type="button"
                    style={styles.shareBtn}
                    onClick={() => {
                      setDraft("");
                      setTokenError(null);
                      setEditingToken(true);
                    }}
                  >
                    + Add
                  </button>
                )}
              </>
            ) : (
              <span style={styles.dim}>none joined yet</span>
            )}
          </div>

          {(editingToken || tokens.length === 0) && (
            <>
              <form onSubmit={joinFromInput} style={styles.tokenForm}>
                <input
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (tokenError) setTokenError(null);
                  }}
                  placeholder="paste a room token to join"
                  style={styles.input}
                  autoFocus={editingToken}
                />
                <button type="submit" style={styles.button}>
                  Join
                </button>
                {editingToken && tokens.length > 0 && (
                  <button
                    type="button"
                    style={styles.shareBtn}
                    onClick={() => {
                      setEditingToken(false);
                      setTokenError(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </form>
              {tokenError ? (
                <p style={styles.tokenError}>{tokenError}</p>
              ) : (
                <p style={styles.tokenHint}>Token requires {TOKEN_REQUIREMENTS}.</p>
              )}
            </>
          )}

          {tokens.length > 0 && (
            <>
              <form onSubmit={openGithubUrl} style={styles.ghForm}>
                <input
                  value={ghUrl}
                  onChange={(e) => {
                    setGhUrl(e.target.value);
                    if (ghError) setGhError(null);
                  }}
                  placeholder="open a repo…  paste a github.com URL"
                  style={styles.input}
                />
                <button type="submit" style={styles.button}>
                  Open
                </button>
              </form>
              {ghError && <p style={styles.tokenError}>{ghError}</p>}
            </>
          )}
          </div>

          <div style={styles.listHead}>
            <h2 style={styles.h2}>Workspaces</h2>
            {serverCount > 0 && (
              <span style={styles.count}>
                {filtered.length === tagged.length
                  ? `${tagged.length}`
                  : `${filtered.length} / ${tagged.length}`}
              </span>
            )}
          </div>
          {tokens.length > 0 && serverCount === 0 && (
            <p style={styles.dim}>No servers online in your rooms yet.</p>
          )}
          {serverCount === 0 && <SetupCard />}
          {serverCount > 0 && (
            <>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…  e.g.  repo:codehost  host:mbp  room:ab12  (space = AND)"
                style={styles.search}
              />
              {(activeTags.length > 0 || suggestedTags.length > 0) && (
                <div style={styles.chipRow}>
                  {activeTags.map((t) => (
                    <button key={t} style={{ ...styles.chip, ...styles.chipActive }} onClick={() => toggleTag(t)}>
                      {t} ✕
                    </button>
                  ))}
                  {suggestedTags
                    .filter((t) => !activeTags.includes(t))
                    .map((t) => (
                      <button key={t} style={styles.chip} onClick={() => toggleTag(t)}>
                        {t}
                      </button>
                    ))}
                </div>
              )}
            </>
          )}
          <div>
            {hostGroups.map((g) => {
              // Only a live root daemon (`serve`) has provisioning wired — a group
              // made up solely of `dev`-kind peers has no provision-config route.
              const rootServer = g.items.find((x) => x.server.meta?.kind === "root" && x.server.meta?.host)?.server;
              return (
              <section key={g.key}>
                <div style={styles.hostHead}>
                  <span style={styles.hostName}>{g.label}</span>
                  <span style={styles.count}>
                    {g.items.length} workspace{g.items.length === 1 ? "" : "s"}
                    {g.agents.length > 0 && ` · ${g.agents.length} agent${g.agents.length === 1 ? "" : "s"}`}
                  </span>
                  {rootServer && (
                    <button
                      style={styles.hostSettingsBtn}
                      title="view/edit this host's .codehost provisioning files"
                      onClick={() => {
                        history.pushState(null, "", `/host/${rootServer.meta!.host}#provisioning`);
                        setSettingsTab("provisioning");
                        setResolving(null);
                        syncToUrl();
                      }}
                    >
                      ⚙ Settings
                    </button>
                  )}
                </div>
                {g.agents.length > 0 && (
                  <div style={styles.agentRow}>
                    {g.agents.map((a) => (
                      <a
                        key={a.pid}
                        style={styles.agentChip}
                        title={`${a.cwd}${a.title ? `\n${a.title}` : ""}\nopen in the agent-yes console`}
                        // Tail & send live in the agent-yes console — it joins
                        // this same room as a viewer (token rides the fragment,
                        // never sent to a server) and auto-selects the pid.
                        href={`https://agent-yes.com/?pid=${a.pid}#ch:${encodeURIComponent(a.room)}`}
                        target="_blank"
                        rel="noopener"
                      >
                        <span style={{ color: a.state === "active" ? "var(--ch-accent-teal)" : "var(--ch-text-dim)" }}>●</span> {a.tool}{" "}
                        {a.pid}
                        {a.title && <span style={styles.agentTitle}>{a.title}</span>}
                      </a>
                    ))}
                  </div>
                )}
                <ul style={styles.list}>
                  {g.items.map(({ server: s, room, name, tags }) => {
                    const isActive = s.peerId === activePeerId;
                    // A root daemon listing many checkouts gets the whole row,
                    // so its links can flow into columns.
                    const wide = (s.meta?.workspaces?.length ?? 0) > 3;
                    return (
                      <li key={s.peerId} style={{ ...styles.card, ...(wide ? { gridColumn: "1 / -1" } : {}) }}>
                        <div style={styles.cardMain}>
                          <div style={styles.cardName}>{name}</div>
                          <div style={styles.tagRow}>
                            {tags.map((tag) => (
                              <button key={tag} style={styles.tag} onClick={() => addTag(tag)} title={`filter by ${tag}`}>
                                {tag}
                              </button>
                            ))}
                          </div>
                          {(s.meta?.workspaces?.length ?? 0) > 0 && (
                            <div style={styles.wsRow}>
                              {s.meta!.workspaces!.map((w) => (
                                <button
                                  key={w.path}
                                  style={styles.wsLink}
                                  onClick={() => openWorkspace(s, w)}
                                  title={w.config ? `edit this host's provisioning config\n${w.path}` : w.path}
                                >
                                  {w.config
                                    ? "⚙ .codehost (setup.sh, config.yaml)"
                                    : w.repo
                                      ? `${w.repo.split("/").slice(1).join("/")}${w.branch ? ` @${w.branch}` : ""}`
                                      : w.path}
                                </button>
                              ))}
                            </div>
                          )}
                          <div style={styles.idLine}>peer {s.peerId.slice(0, 8)}</div>
                          {isActive && (
                            <div style={connState === "denied" ? styles.echoBad : styles.echo}>
                              {connState === "connecting" && "negotiating WebRTC…"}
                              {connState === "pending" && "waiting for the host to approve you…"}
                              {connState === "failed" && "connection failed"}
                              {connState === "denied" && "the host denied this connection"}
                            </div>
                          )}
                        </div>
                        <button
                          style={styles.connectBtn}
                          onClick={() => connectTo(s, room)}
                          disabled={isActive && (connState === "connecting" || connState === "pending")}
                        >
                          {isActive && (connState === "connecting" || connState === "pending") ? "…" : "Connect"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
              );
            })}
            {serverCount > 0 && filtered.length === 0 && (
              <p style={styles.dim}>No workspace matches your filter.</p>
            )}
          </div>

          {tokens.length > 0 && (
            <section style={styles.rosterSection}>
              <div style={styles.rosterHead}>
                In this room · you{otherClients.length > 0 ? ` + ${otherClients.length} other ${otherClients.length === 1 ? "client" : "clients"}` : ""}
              </div>
              <ul style={styles.list}>
                <li style={styles.personRow}>
                  <span style={styles.personDot}>●</span>
                  <span style={styles.personName}>{labelRef.current}</span>
                  <span style={styles.dim}>you</span>
                </li>
                {otherClients.map((c) => {
                  const age = relTime(c.since, roomNow);
                  return (
                    <li key={c.peerId} style={styles.personRow}>
                      <span style={{ ...styles.personDot, color: "var(--ch-accent-amber)" }}>●</span>
                      <span style={styles.personName}>{c.meta?.name ?? c.peerId.slice(0, 8)}</span>
                      {age && <span style={styles.dim}>connected {age} ago</span>}
                    </li>
                  );
                })}
              </ul>
              <p style={styles.rosterHint}>
                Anyone holding a room's token can appear here and gets a full VS Code session
                (terminal + file write). See a device you don't recognize? Rotate the token with{" "}
                <code style={styles.code}>codehost setup --new-token</code>.
              </p>
            </section>
          )}

          {/* When servers already exist the empty-state card is hidden, so keep an
              "add another machine" affordance available down here. */}
          {serverCount > 0 && <SetupCard />}
        </main>
      </div>
    </>
  );
}

// Colors reference the var(--ch-*) custom properties defined in style.css,
// which switch between a light default and a dark override on
// `prefers-color-scheme` — so the whole page follows the OS theme. `#fff` is
// left literal only for text sitting on an always-dark accent-colored button,
// which needs white regardless of page theme.
const styles: Record<string, React.CSSProperties> = {
  page: { display: "flex", flexDirection: "column", height: "100%", background: "var(--ch-bg)", color: "var(--ch-text)", fontFamily: "system-ui, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "var(--ch-bg-alt)", borderBottom: "1px solid var(--ch-border)", fontSize: 13 },
  brand: { fontFamily: "monospace", fontWeight: 700, color: "var(--ch-text-strong)" },
  hostTag: { fontFamily: "monospace", fontSize: 12, color: "var(--ch-accent-yellow)" },
  dim: { color: "var(--ch-text-dim)", fontSize: 12 },
  status: { fontSize: 12 },
  // Wide cap + per-host card GRID below: a 4K monitor gets several columns of
  // workspaces instead of one skinny 760px strip. Inputs keep a readable
  // measure via `controls`.
  main: { flex: 1, overflow: "auto", padding: "20px 24px", maxWidth: 1560, width: "100%", margin: "0 auto", boxSizing: "border-box" },
  controls: { maxWidth: 760 },
  tokenForm: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  tokenHint: { margin: "0 0 20px", fontSize: 12, color: "var(--ch-text-dim)" },
  tokenError: { margin: "0 0 20px", fontSize: 12, color: "var(--ch-accent-red)" },
  label: { fontSize: 12, color: "var(--ch-text-dim)" },
  roomChips: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" },
  roomChip: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ch-text-muted)" },
  roomChipOn: { borderColor: "var(--ch-accent-primary)", color: "var(--ch-accent-teal)" },
  roomChipX: { background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 },
  input: { flex: 1, background: "var(--ch-bg-panel)", border: "1px solid var(--ch-border)", color: "var(--ch-text-input)", padding: "8px 10px", borderRadius: 6, fontSize: 13, outline: "none" },
  button: { background: "var(--ch-accent-primary)", border: "none", color: "#fff", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  ghForm: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 14px" },
  listHead: { display: "flex", alignItems: "baseline", gap: 10, margin: "0 0 12px" },
  h2: { fontSize: 14, color: "var(--ch-text-secondary)", fontWeight: 600, margin: 0 },
  count: { fontSize: 12, color: "var(--ch-text-dim)", fontFamily: "monospace" },
  search: {
    width: "100%", boxSizing: "border-box", background: "var(--ch-bg-panel)", border: "1px solid var(--ch-border)",
    color: "var(--ch-text-input)", padding: "8px 10px", borderRadius: 6, fontSize: 13, outline: "none",
    fontFamily: "monospace", marginBottom: 10,
  },
  chipRow: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 },
  chip: {
    fontFamily: "monospace", fontSize: 11.5, padding: "2px 8px", borderRadius: 999,
    border: "1px solid var(--ch-border)", background: "transparent", color: "var(--ch-text-muted)", cursor: "pointer",
  },
  chipActive: { background: "var(--ch-accent-primary)", borderColor: "var(--ch-accent-primary)", color: "#fff" },
  tagRow: { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 },
  tag: {
    fontFamily: "monospace", fontSize: 11, padding: "1px 7px", borderRadius: 999,
    border: "1px solid var(--ch-border)", background: "transparent", color: "var(--ch-text-muted)", cursor: "pointer",
  },
  idLine: { fontFamily: "monospace", fontSize: 11, color: "var(--ch-text-dim2)", marginTop: 6 },
  // Workspace links flow into columns on wide screens (a busy root daemon can
  // advertise 50+ checkouts — a single column wasted the whole viewport).
  wsRow: {
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "2px 14px", marginTop: 8,
  },
  wsLink: {
    fontFamily: "monospace", fontSize: 12, padding: "2px 0", border: "none", background: "transparent",
    color: "var(--ch-accent-link)", cursor: "pointer", textAlign: "left",
  },
  code: { background: "var(--ch-bg-panel)", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace", fontSize: 12 },
  list: {
    listStyle: "none", margin: "0 0 14px", padding: 0,
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 8,
    alignItems: "start",
  },
  hostHead: { display: "flex", alignItems: "baseline", gap: 10, margin: "0 0 8px" },
  hostName: { fontSize: 13, fontWeight: 600, color: "var(--ch-accent-yellow)", fontFamily: "monospace" },
  hostSettingsBtn: {
    fontFamily: "monospace", fontSize: 11, padding: "1px 8px", borderRadius: 999,
    border: "1px solid var(--ch-border)", background: "transparent", color: "var(--ch-text-muted)", cursor: "pointer",
  },
  agentRow: { display: "flex", flexWrap: "wrap", gap: 6, margin: "0 0 8px" },
  agentChip: {
    fontFamily: "monospace", fontSize: 11.5, padding: "2px 8px", borderRadius: 999,
    border: "1px solid var(--ch-border)", color: "var(--ch-text-muted)", textDecoration: "none", cursor: "pointer",
    display: "inline-flex", alignItems: "baseline", gap: 4, maxWidth: 360,
  },
  // Live self-set agent title (daemon re-reads it from the PTY log and pushes
  // a meta update, so this re-renders as the agent renames itself).
  agentTitle: {
    color: "var(--ch-text-dim2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    minWidth: 0, flex: "0 1 auto",
  },
  card: { display: "flex", alignItems: "center", gap: 12, background: "var(--ch-bg-panel)", border: "1px solid var(--ch-border)", borderRadius: 8, padding: "12px 14px" },
  cardMain: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 14, fontWeight: 600, color: "var(--ch-text-strong)" },
  cardSub: { display: "flex", gap: 12, fontSize: 12, color: "var(--ch-text-dim)", marginTop: 2 },
  cwd: { fontFamily: "monospace" },
  cwdLink: { fontFamily: "monospace", color: "var(--ch-accent-link)", textDecoration: "none" },
  echo: { marginTop: 6, fontSize: 12, color: "var(--ch-accent-teal)", fontFamily: "monospace" },
  echoBad: { marginTop: 6, fontSize: 12, color: "var(--ch-accent-red)", fontFamily: "monospace" },
  rosterSection: { marginTop: 28 },
  rosterHead: { fontSize: 14, color: "var(--ch-text-secondary)", fontWeight: 600, margin: "0 0 12px" },
  setupCard: { marginTop: 20, background: "var(--ch-bg-panel)", border: "1px solid var(--ch-border)", borderRadius: 8, padding: "16px 18px" },
  setupHead: { fontSize: 15, color: "var(--ch-text-strong)", fontWeight: 600, marginBottom: 6 },
  setupSub: { fontSize: 13, color: "var(--ch-text-secondary)", margin: "0 0 14px", lineHeight: 1.5 },
  cmdRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 },
  cmdRowNarrow: { flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 },
  cmdLabel: { fontSize: 11, color: "var(--ch-text-dim)", width: 88, flexShrink: 0 },
  cmdLabelNarrow: { width: "auto" },
  cmdCode: { flex: 1, minWidth: 0, background: "var(--ch-bg-code-alt)", border: "1px solid var(--ch-border)", borderRadius: 6, padding: "8px 10px", fontFamily: "monospace", fontSize: 12.5, color: "var(--ch-accent-yellow)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  cmdCopy: { flexShrink: 0, background: "var(--ch-accent-primary)", border: "none", color: "#fff", padding: "8px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12 },
  cmdCopyNarrow: { width: "100%", padding: "10px 12px" },
  rosterHint: { margin: "10px 0 0", fontSize: 12, color: "var(--ch-text-dim)" },
  personRow: { display: "flex", alignItems: "center", gap: 10, background: "var(--ch-bg-panel)", border: "1px solid var(--ch-border)", borderRadius: 8, padding: "8px 14px", fontSize: 13 },
  personDot: { color: "var(--ch-accent-teal)", fontSize: 10 },
  personName: { color: "var(--ch-text-input)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  connectBtn: { background: "var(--ch-accent-primary)", border: "none", color: "#fff", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  shareBtn: { background: "transparent", border: "1px solid var(--ch-border)", color: "var(--ch-text)", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  provLog: { flex: 1, margin: 0, padding: "14px 18px", overflow: "auto", background: "var(--ch-bg-code)", color: "var(--ch-text)", fontFamily: "monospace", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap" },
  settingsLabel: { display: "block", fontSize: 12, color: "var(--ch-text-secondary)", margin: "18px 0 6px", fontFamily: "monospace" },
  settingsArea: { width: "100%", minHeight: 180, padding: "10px 12px", background: "var(--ch-bg-code)", color: "var(--ch-text)", border: "1px solid var(--ch-border)", borderRadius: 6, fontFamily: "monospace", fontSize: 12.5, lineHeight: 1.5, boxSizing: "border-box", resize: "vertical" },
};
