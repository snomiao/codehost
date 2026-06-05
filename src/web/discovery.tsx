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
  parseDeepLink,
  repoKey,
  resolveDevTarget,
  resolveRepoTarget,
} from "../shared/repo";
import { addRoom, historyFor, recordConnection } from "./history";

const TOKEN_KEY = "codehost.token";

type ConnState = "idle" | "connecting" | "connected" | "failed";

/** Short label for the "looking for…" state from a deep link. */
function deepLinkLabel(dl: DeepLink): string | null {
  if (!dl) return null;
  return dl.type === "repo" ? `${dl.target.owner}/${dl.target.name}` : dl.target.path;
}

function folderQuery(folder?: string): string {
  return folder ? `?folder=${encodeURIComponent(folder)}` : "";
}

export function Discovery() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
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
  const activeFolderRef = useRef<string | undefined>(undefined);
  const [resolving, setResolving] = useState<string | null>(() => deepLinkLabel(deepLinkRef.current));

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
    // For a repo deep link, adopt the room that last served it so it resolves
    // without re-entering a token.
    const dl = deepLinkRef.current;
    if (dl?.type === "repo") {
      const h = historyFor(repoKey(dl.target));
      if (h?.token) setToken(h.token);
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
      activeFolderRef.current = folder;
      setIframeSrc(`/vs/${server.peerId}/${folderQuery(folder)}`);
      setResolving(null);
      recordConnect(server, folder);
    } catch {
      setConnState("failed");
    }
  }

  // Deep-link auto-connect: when servers arrive, pick the best match (exact repo
  // daemon, else a root daemon's subfolder) and open it once.
  async function tryAutoConnect(list: PeerInfo[]) {
    const dl = deepLinkRef.current;
    if (!dl || resolvedRef.current) return;
    const res = dl.type === "repo" ? resolveRepoTarget(list, dl.target) : resolveDevTarget(list, dl.target);
    if (!res) return;
    const server = list.find((s) => s.peerId === res.peerId);
    if (!server) return;
    resolvedRef.current = true;
    await connectTo(server, res.folder);
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
};
