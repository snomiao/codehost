import { useEffect, useRef, useState } from "react";
import type { PeerInfo } from "../shared/signaling";
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
  type RoomMatch,
  gitUrlToPath,
  parseDeepLink,
  pickRoomMatch,
  repoKey,
  resolveDevTarget,
  resolveRepoTarget,
  shareableDeepLink,
} from "../shared/repo";
import { getRooms, historyFor, recordConnection, setRooms } from "./history";
import { deriveTags, matchQuery, shortRoomLabel, tagKey } from "../shared/tags";

const TOKEN_KEY = "codehost.token";

type ConnState = "idle" | "connecting" | "provisioning" | "connected" | "failed";

/** A server discovered in a specific room (its token routes the signaling). */
type RoomedServer = { server: PeerInfo; room: string };

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
  return dl.target.host ? `${dl.target.host}:${dl.target.path}` : dl.target.path;
}

function folderQuery(folder?: string): string {
  return folder ? `?folder=${encodeURIComponent(folder)}` : "";
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
        role: "viewer",
        onPeers: (peers) => {
          const servers = peers.filter((p) => p.role === "server");
          const res =
            dl.type === "repo" ? resolveRepoTarget(servers, dl.target) : resolveDevTarget(servers, dl.target);
          if (!res) return;
          if (!res.folder) finish(tok); // exact match — take it now
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
  onPeers: (peers: PeerInfo[]) => void;
  onStatus: (open: boolean) => void;
  onSignal: (from: string, data: unknown) => void;
  registerSender: (send: ((to: string, data: unknown) => void) | null) => void;
}) {
  // Keep the latest callbacks in a ref so the socket effect runs once per token,
  // not on every parent re-render (which would needlessly churn the WebSocket).
  const cb = useRef(props);
  cb.current = props;
  const { token } = props;
  useEffect(() => {
    const client = new SignalingClient({
      url: getSignalUrl(),
      token,
      role: "viewer",
      onOpen: () => cb.current.onStatus(true),
      onClose: () => cb.current.onStatus(false),
      onPeers: (peers) => cb.current.onPeers(peers.filter((p) => p.role === "server")),
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
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  // Streamed setup.sh output shown while connState === "provisioning".
  const [provisionLog, setProvisionLog] = useState("");

  const rtcRef = useRef<RtcClient | null>(null);
  const activePeerRef = useRef<string | null>(null);
  const activeRoomRef = useRef<string | null>(null);
  const sendersRef = useRef<Map<string, (to: string, data: unknown) => void>>(new Map());
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

    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Auto-connect once discovery turns up a match: a deep-link target across any
  // room, or the lone server of a room joined via #t=.
  useEffect(() => {
    if (resolvedRef.current) return;
    tryAutoConnect();
  }, [serversByRoom, tokens]);

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
    repoTarget?: RepoTarget,
  ) {
    const send = sendersRef.current.get(room);
    if (!send) return;
    dialingRef.current = true; // synchronous gate against concurrent triggers
    let didPush = false;
    try {
      // Clear any prior connection's broker state first: after an RTC drop the
      // broker still holds the dead channel in `locals`, so re-dialing the same
      // peer would otherwise resolve straight to it. Also covers switching peers.
      if (activePeerRef.current) connBroker.disconnect(activePeerRef.current);

      rtcRef.current?.close();
      rtcRef.current = null;
      setIframeSrc(null);
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
        new Promise<RTCDataChannel>((resolve, reject) => {
          const rtc = new RtcClient({
            sendSignal: (data: RtcSignal) => send(server.peerId, data),
            onState: (state) => {
              if (state === "failed" || state === "disconnected") setConnState("failed");
            },
            onOpen: (channel) => {
              clearTimeout(timer);
              resolve(channel);
            },
            onClose: () => setConnState((s) => (s === "connected" ? "idle" : s)),
          });
          rtcRef.current = rtc;
          // Don't hang forever dialing a peer that never answers (e.g. a stale
          // server still listed in the room): fail the attempt after 15s.
          const timer = setTimeout(() => {
            rtc.close();
            reject(new Error("connection timed out"));
          }, 15000);
          rtc.start().catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

      await connBroker.connect(server.peerId, establish);

      // For a repo deep link, ask the daemon to provision (run .codehost/setup.sh
      // and hand back the authoritative workspace path) before opening. Streams
      // the log under the "provisioning" state. Daemons without the route (older
      // builds) return no path → fall back to the browser-computed folder.
      if (repoTarget) {
        setConnState("provisioning");
        setProvisionLog("");
        const ws = await runProvision(server.peerId, repoTarget);
        if (activePeerRef.current !== server.peerId) return; // cancelled/switched mid-provision
        if (ws) openFolder = ws;
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
      setConnState("failed");
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

  // Deep-link auto-connect: when servers arrive, pick the best match (exact repo
  // daemon, else a root daemon's subfolder) across all rooms and open it once.
  function tryAutoConnect() {
    if (resolvedRef.current) return;
    const dl = deepLinkRef.current;
    if (dl) {
      const peers = allServers.map((x) => x.server);
      const res = dl.type === "repo" ? resolveRepoTarget(peers, dl.target) : resolveDevTarget(peers, dl.target);
      if (!res) return;
      const match = allServers.find((x) => x.server.peerId === res.peerId);
      if (!match) return;
      resolvedRef.current = true;
      void connectTo(match.server, match.room, res.folder, false, dl.type === "repo" ? dl.target : undefined);
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
      peerId: server.peerId,
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
    setActivePeerId(null);
    activePeerRef.current = null;
    activeRoomRef.current = null;
    setConnState("idle");
    sharePathRef.current = null;
    pushedRef.current = false;
  }

  // Resolve a workspace deep-link path to a live server across all joined rooms.
  function findServerForDeepLink(dl: DeepLink): (RoomedServer & { folder?: string }) | null {
    if (!dl) return null;
    const peers = allServersRef.current.map((x) => x.server);
    const res = dl.type === "repo" ? resolveRepoTarget(peers, dl.target) : resolveDevTarget(peers, dl.target);
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
    void connectTo(target.server, target.room, target.folder, true, dl.type === "repo" ? dl.target : undefined);
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
  const hostGroups: { key: string; label: string; items: typeof filtered }[] = [];
  for (const t of filtered) {
    const key = t.server.meta?.hostId ?? t.server.meta?.host ?? t.server.peerId;
    let group = hostGroups.find((g) => g.key === key);
    if (!group) {
      group = { key, label: t.server.meta?.host ?? t.name, items: [] };
      hostGroups.push(group);
    }
    group.items.push(t);
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
      onPeers={(peers) => setServersByRoom((m) => ({ ...m, [t]: peers }))}
      onStatus={(open) => setRoomOpen((m) => ({ ...m, [t]: open }))}
      onSignal={(from, data) => {
        if (from === activePeerRef.current) void rtcRef.current?.handleSignal(data);
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

  // Connected view: VS Code in an iframe, served over the tunnel.
  if (iframeSrc && connState === "connected") {
    return (
      <>
        {roomClients}
        <div style={styles.page}>
          <header style={styles.header}>
            <span style={styles.brand}>codehost</span>
            <span style={styles.dim}>·</span>
            <span style={styles.dim}>{activeServer?.meta?.name ?? activePeerId?.slice(0, 8)}</span>
            {activeServer?.meta?.cwd && <span style={styles.cwd}>{activeServer.meta.cwd}</span>}
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
          <iframe title="VS Code" src={iframeSrc} style={{ flex: 1, border: "none", width: "100%", background: "#1e1e1e" }} />
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
          <span style={{ ...styles.status, color: onlineRooms > 0 ? "#4ec9b0" : "#888" }}>
            {tokens.length === 0
              ? "○ no rooms"
              : `${onlineRooms > 0 ? "●" : "○"} ${onlineRooms}/${tokens.length} rooms`}
          </span>
        </header>

        <main style={styles.main}>
          {resolving && (
            <p style={{ color: "#dcb67a", marginBottom: 12 }}>
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
          {tokens.length === 0 && <p style={styles.dim}>Join a room to see your workspaces.</p>}
          {tokens.length > 0 && serverCount === 0 && (
            <p style={styles.dim}>
              No servers online. Run <code style={styles.code}>bunx codehost serve -t &lt;token&gt;</code> on a machine.
            </p>
          )}
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
            {hostGroups.map((g) => (
              <section key={g.key}>
                <div style={styles.hostHead}>
                  <span style={styles.hostName}>{g.label}</span>
                  <span style={styles.count}>
                    {g.items.length} workspace{g.items.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ul style={styles.list}>
                  {g.items.map(({ server: s, room, name, tags }) => {
                    const isActive = s.peerId === activePeerId;
                    return (
                      <li key={s.peerId} style={styles.card}>
                        <div style={styles.cardMain}>
                          <div style={styles.cardName}>{name}</div>
                          <div style={styles.tagRow}>
                            {tags.map((tag) => (
                              <button key={tag} style={styles.tag} onClick={() => addTag(tag)} title={`filter by ${tag}`}>
                                {tag}
                              </button>
                            ))}
                          </div>
                          <div style={styles.idLine}>peer {s.peerId.slice(0, 8)}</div>
                          {isActive && (
                            <div style={styles.echo}>
                              {connState === "connecting" && "negotiating WebRTC…"}
                              {connState === "failed" && "connection failed"}
                            </div>
                          )}
                        </div>
                        <button
                          style={styles.connectBtn}
                          onClick={() => connectTo(s, room)}
                          disabled={isActive && connState === "connecting"}
                        >
                          {isActive && connState === "connecting" ? "…" : "Connect"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {serverCount > 0 && filtered.length === 0 && (
              <p style={styles.dim}>No workspace matches your filter.</p>
            )}
          </div>
        </main>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: "flex", flexDirection: "column", height: "100%", background: "#1f1f1f", color: "#ccc", fontFamily: "system-ui, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "#2d2d2d", borderBottom: "1px solid #3d3d3d", fontSize: 13 },
  brand: { fontFamily: "monospace", fontWeight: 700, color: "#fff" },
  dim: { color: "#888", fontSize: 12 },
  status: { fontSize: 12 },
  main: { flex: 1, overflow: "auto", padding: "20px 24px", maxWidth: 760, width: "100%", margin: "0 auto", boxSizing: "border-box" },
  tokenForm: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  tokenHint: { margin: "0 0 20px", fontSize: 12, color: "#888" },
  tokenError: { margin: "0 0 20px", fontSize: 12, color: "#f48771" },
  label: { fontSize: 12, color: "#888" },
  roomChips: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" },
  roomChip: { display: "inline-flex", alignItems: "center", gap: 6, color: "#9aa4af" },
  roomChipOn: { borderColor: "#0e639c", color: "#4ec9b0" },
  roomChipX: { background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 },
  input: { flex: 1, background: "#252525", border: "1px solid #3d3d3d", color: "#eee", padding: "8px 10px", borderRadius: 6, fontSize: 13, outline: "none" },
  button: { background: "#0e639c", border: "none", color: "#fff", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  ghForm: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 14px" },
  listHead: { display: "flex", alignItems: "baseline", gap: 10, margin: "0 0 12px" },
  h2: { fontSize: 14, color: "#aaa", fontWeight: 600, margin: 0 },
  count: { fontSize: 12, color: "#888", fontFamily: "monospace" },
  search: {
    width: "100%", boxSizing: "border-box", background: "#252525", border: "1px solid #3d3d3d",
    color: "#eee", padding: "8px 10px", borderRadius: 6, fontSize: 13, outline: "none",
    fontFamily: "monospace", marginBottom: 10,
  },
  chipRow: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 },
  chip: {
    fontFamily: "monospace", fontSize: 11.5, padding: "2px 8px", borderRadius: 999,
    border: "1px solid #3d3d3d", background: "transparent", color: "#9aa4af", cursor: "pointer",
  },
  chipActive: { background: "#0e639c", borderColor: "#0e639c", color: "#fff" },
  tagRow: { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 },
  tag: {
    fontFamily: "monospace", fontSize: 11, padding: "1px 7px", borderRadius: 999,
    border: "1px solid #3d3d3d", background: "transparent", color: "#9aa4af", cursor: "pointer",
  },
  idLine: { fontFamily: "monospace", fontSize: 11, color: "#666", marginTop: 6 },
  code: { background: "#252525", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace", fontSize: 12 },
  list: { listStyle: "none", margin: "0 0 14px", padding: 0, display: "flex", flexDirection: "column", gap: 8 },
  hostHead: { display: "flex", alignItems: "baseline", gap: 10, margin: "0 0 8px" },
  hostName: { fontSize: 13, fontWeight: 600, color: "#dcdcaa", fontFamily: "monospace" },
  card: { display: "flex", alignItems: "center", gap: 12, background: "#252525", border: "1px solid #3d3d3d", borderRadius: 8, padding: "12px 14px" },
  cardMain: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 14, fontWeight: 600, color: "#fff" },
  cardSub: { display: "flex", gap: 12, fontSize: 12, color: "#888", marginTop: 2 },
  cwd: { fontFamily: "monospace" },
  echo: { marginTop: 6, fontSize: 12, color: "#4ec9b0", fontFamily: "monospace" },
  connectBtn: { background: "#0e639c", border: "none", color: "#fff", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  shareBtn: { background: "transparent", border: "1px solid #3d3d3d", color: "#ccc", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  provLog: { flex: 1, margin: 0, padding: "14px 18px", overflow: "auto", background: "#1e1e1e", color: "#ccc", fontFamily: "monospace", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap" },
};
