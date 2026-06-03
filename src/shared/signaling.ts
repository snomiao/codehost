// Signaling protocol shared by the browser, the CLI daemon, and the Cloudflare
// Worker / Durable Object. A "room" is keyed by the user's token; every member
// of a room can see the others and exchange WebRTC SDP/ICE via the relay.

export type Role = "server" | "viewer";

/** Metadata a `codehost serve` daemon advertises about itself. */
export interface PeerMeta {
  /** Human label, defaults to hostname. */
  name: string;
  /** Directory the VS Code instance is serving. */
  cwd: string;
  /** Hostname of the machine running the daemon. */
  host: string;
}

export interface PeerInfo {
  peerId: string;
  role: Role;
  meta: PeerMeta | null;
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

export type ClientMessage = HelloMessage | SignalMessage | PingMessage;

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
