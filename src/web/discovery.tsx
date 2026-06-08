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
  type DeepLink,
  type RoomMatch,
  parseDeepLink,
  pickRoomMatch,
  repoKey,
  resolveDevTarget,
  resolveRepoTarget,
  shareableDeepLink,
} from "../shared/repo";
import { addRoom, getRooms, historyFor, recordConnection } from "./history";

const TOKEN_KEY = "codehost.token";

type ConnState = "idle" | "connecting" | "connected" | "failed";

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
  return dl.type === "repo" ? `${dl.target.owner}/${dl.target.name}` : dl.target.path;
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

export function Discovery() {
  const [token, setToken] = useState(() => {
    const fromHash = tokenFromHash();
    if (fromHash && validateToken(fromHash).ok) {
      localStorage.setItem(TOKEN_KEY, fromHash);
      return fromHash;
    }
    return localStorage.getItem(TOKEN_KEY) ?? "";
  });
  const [draft, setDraft] = useState(token);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [servers, setServers] = useState<PeerInfo[]>([]);

  // Active WebRTC connection to one server (Phase 2: echo test).
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnState>("idle");

  // Once a server's data channel is open we mount its VS Code in an iframe.
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);

  const clientRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<RtcClient | null>(null);
  const activePeerRef = useRef<string | null>(null);

  // Deep-link resolution (/gh/<owner>/<repo>/... or /dev/<path>): parse once,
  // auto-connect when a matching server appears, remember the opened folder.
  const deepLinkRef = useRef<DeepLink>(parseDeepLink(window.location.pathname));
  const resolvedRef = useRef(false);
  // A valid token in the URL fragment enables single-server auto-connect.
  const autoConnectRef = useRef(false);
  const activeFolderRef = useRef<string | undefined>(undefined);
  const [resolving, setResolving] = useState<string | null>(() => deepLinkLabel(deepLinkRef.current));

  // Shareable deep-link pathname for the live connection (drives the address bar
  // and the Share button); transient "copied" flag for the button.
  const sharePathRef = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    // A valid token in the URL fragment (#t=<token>) seeds the room and turns on
    // single-server auto-connect; consume it from the address bar afterwards so
    // the secret isn't left visible or re-applied on a manual reload.
    const urlToken = tokenFromHash();
    if (urlToken && validateToken(urlToken).ok) {
      autoConnectRef.current = true;
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
        setToken(histToken);
      } else {
        const rooms = getRooms();
        if (rooms.length) {
          void findRoomForDeepLink(dl, rooms).then((tok) => {
            if (tok) setToken(tok);
          });
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const client = new SignalingClient({
      url: getSignalUrl(),
      token,
      role: "viewer",
      onOpen: () => {
        setConnected(true);
        addRoom(token);
      },
      onClose: () => setConnected(false),
      onPeers: (peers) => {
        const list = peers.filter((p) => p.role === "server");
        setServers(list);
        void tryAutoConnect(list);
      },
      onSignal: (from, data) => {
        if (from === activePeerRef.current) void rtcRef.current?.handleSignal(data);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      rtcRef.current?.close();
      rtcRef.current = null;
      if (activePeerRef.current) connBroker.disconnect(activePeerRef.current);
      client.close();
      clientRef.current = null;
      setConnected(false);
      setServers([]);
      setActivePeerId(null);
      activePeerRef.current = null;
      setConnState("idle");
      setIframeSrc(null);
    };
  }, [token]);

  function applyToken(e: React.FormEvent) {
    e.preventDefault();
    const t = draft.trim();
    const check = validateToken(t);
    if (!check.ok) {
      setTokenError(check.reason ?? "invalid token");
      return;
    }
    setTokenError(null);
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
  }

  async function connectTo(server: PeerInfo, folder?: string) {
    const client = clientRef.current;
    if (!client) return;

    rtcRef.current?.close();
    rtcRef.current = null;
    setIframeSrc(null);
    setActivePeerId(server.peerId);
    activePeerRef.current = server.peerId;
    setConnState("connecting");

    // The broker decides whether this tab owns the connection. `establish` is
    // only invoked when we're the owner (or get promoted on failover); other
    // tabs reuse the owner's channel via a proxy, so they never open WebRTC.
    const establish = () =>
      new Promise<RTCDataChannel>((resolve, reject) => {
        const rtc = new RtcClient({
          sendSignal: (data: RtcSignal) => client.sendSignal(server.peerId, data),
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

    try {
      await connBroker.connect(server.peerId, establish);
      setConnState("connected");
      // The daemon no longer sets a default folder (current VS Code serve-web
      // dropped that flag), so open the served workspace from here: an explicit
      // deep-link folder if we have one, else the server's reported cwd.
      const openFolder = folder ?? server.meta?.cwd;
      activeFolderRef.current = openFolder;
      setIframeSrc(`/vs/${server.peerId}/${folderQuery(openFolder)}`);
      setResolving(null);
      recordConnect(server, openFolder);
      updateAddressBar(server, openFolder);
    } catch {
      setConnState("failed");
    }
  }

  // Reflect the live connection in the address bar as a clean, shareable deep
  // link (no token — Share adds that). If we arrived via a deep link, keep its
  // pathname; otherwise derive one from the server's repo identity or folder.
  function updateAddressBar(server: PeerInfo, folder?: string) {
    const path = deepLinkRef.current
      ? window.location.pathname
      : shareableDeepLink({ repo: server.meta?.repo, branch: server.meta?.branch, folder });
    if (!path) return;
    sharePathRef.current = path;
    if (path !== window.location.pathname) history.replaceState(null, "", path);
  }

  async function shareLink() {
    const path = sharePathRef.current ?? window.location.pathname;
    const url = `${window.location.origin}${path}#t=${encodeURIComponent(token)}`;
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
  // daemon, else a root daemon's subfolder) and open it once.
  async function tryAutoConnect(list: PeerInfo[]) {
    if (resolvedRef.current) return;
    const dl = deepLinkRef.current;
    if (dl) {
      const res = dl.type === "repo" ? resolveRepoTarget(list, dl.target) : resolveDevTarget(list, dl.target);
      if (!res) return;
      const server = list.find((s) => s.peerId === res.peerId);
      if (!server) return;
      resolvedRef.current = true;
      await connectTo(server, res.folder);
      return;
    }
    // No deep link, but a token arrived via the URL: open the room's server
    // straight away when there's exactly one; with several, leave the picker.
    if (autoConnectRef.current && list.length === 1) {
      resolvedRef.current = true;
      await connectTo(list[0]);
    }
  }

  function recordConnect(server: PeerInfo, folder?: string) {
    const base = {
      token,
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

  function disconnect() {
    rtcRef.current?.close();
    rtcRef.current = null;
    if (activePeerRef.current) connBroker.disconnect(activePeerRef.current);
    setIframeSrc(null);
    setActivePeerId(null);
    activePeerRef.current = null;
    setConnState("idle");
    sharePathRef.current = null;
    if (window.location.pathname !== "/") history.replaceState(null, "", "/");
  }

  const activeServer = servers.find((s) => s.peerId === activePeerId);

  // Connected view: VS Code in an iframe, served over the tunnel.
  if (iframeSrc && connState === "connected") {
    return (
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
    );
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.brand}>codehost</span>
        <span style={styles.dim}>·</span>
        <span style={styles.dim}>{getSignalUrl()}</span>
        <span style={{ flex: 1 }} />
        <span style={{ ...styles.status, color: connected ? "#4ec9b0" : "#888" }}>
          {token ? (connected ? "● connected" : "○ connecting…") : "○ no token"}
        </span>
      </header>

      <main style={styles.main}>
        {resolving && (
          <p style={{ color: "#dcb67a", marginBottom: 12 }}>
            Looking for <code style={styles.code}>{resolving}</code> in your rooms…{" "}
            {token ? "waiting for a live server" : "enter the room's token below"}.
          </p>
        )}
        <form onSubmit={applyToken} style={styles.tokenForm}>
          <label style={styles.label}>Token</label>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (tokenError) setTokenError(null);
            }}
            placeholder="your room token"
            style={styles.input}
          />
          <button type="submit" style={styles.button}>
            {token === draft.trim() ? "Reconnect" : "Connect"}
          </button>
        </form>
        {tokenError ? (
          <p style={styles.tokenError}>{tokenError}</p>
        ) : (
          <p style={styles.tokenHint}>Token requires {TOKEN_REQUIREMENTS}.</p>
        )}

        <h2 style={styles.h2}>VS Code servers</h2>
        {!token && <p style={styles.dim}>Enter a token to see your servers.</p>}
        {token && servers.length === 0 && (
          <p style={styles.dim}>
            No servers online. Run{" "}
            <code style={styles.code}>bunx codehost serve -t {token || "<token>"}</code> on a machine.
          </p>
        )}
        <ul style={styles.list}>
          {servers.map((s) => {
            const isActive = s.peerId === activePeerId;
            return (
              <li key={s.peerId} style={styles.card}>
                <div style={styles.cardMain}>
                  <div style={styles.cardName}>{s.meta?.name ?? s.peerId.slice(0, 8)}</div>
                  <div style={styles.cardSub}>
                    {s.meta?.host && <span>{s.meta.host}</span>}
                    {s.meta?.cwd && <span style={styles.cwd}>{s.meta.cwd}</span>}
                  </div>
                  {isActive && (
                    <div style={styles.echo}>
                      {connState === "connecting" && "negotiating WebRTC…"}
                      {connState === "failed" && "connection failed"}
                    </div>
                  )}
                </div>
                <button
                  style={styles.connectBtn}
                  onClick={() => connectTo(s)}
                  disabled={isActive && connState === "connecting"}
                >
                  {isActive && connState === "connecting" ? "…" : "Connect"}
                </button>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
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
  input: { flex: 1, background: "#252525", border: "1px solid #3d3d3d", color: "#eee", padding: "8px 10px", borderRadius: 6, fontSize: 13, outline: "none" },
  button: { background: "#0e639c", border: "none", color: "#fff", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  h2: { fontSize: 14, color: "#aaa", fontWeight: 600, margin: "0 0 12px" },
  code: { background: "#252525", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace", fontSize: 12 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 },
  card: { display: "flex", alignItems: "center", gap: 12, background: "#252525", border: "1px solid #3d3d3d", borderRadius: 8, padding: "12px 14px" },
  cardMain: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 14, fontWeight: 600, color: "#fff" },
  cardSub: { display: "flex", gap: 12, fontSize: 12, color: "#888", marginTop: 2 },
  cwd: { fontFamily: "monospace" },
  echo: { marginTop: 6, fontSize: 12, color: "#4ec9b0", fontFamily: "monospace" },
  connectBtn: { background: "#0e639c", border: "none", color: "#fff", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  shareBtn: { background: "transparent", border: "1px solid #3d3d3d", color: "#ccc", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
};
