import type {
  ClientMessage,
  PeerInfo,
  PeerMeta,
  Role,
  ServerMessage,
} from "../src/shared/signaling";

interface Attachment {
  peerId: string;
  role: Role;
  meta: PeerMeta | null;
  /** Wall-clock ms of the last message from this socket (hello / ping / signal). */
  lastSeen: number;
}

/** How often the room scans for dead sockets, and how long a socket may go
 *  silent before eviction. Clients heartbeat every ~25s (HEARTBEAT_MS in
 *  signaling-client.ts); allow ~2 misses, so a crashed peer drops out within
 *  ~65-85s. Every sweep alarm and every ping is a billable DO request, so both
 *  cadences are deliberately slow — a hidden Chrome tab's throttled timers
 *  (1/min) must still beat STALE_MS, or background tabs churn evict/reconnect
 *  cycles all day. */
const SWEEP_MS = 20_000;
const STALE_MS = 65_000;

/**
 * One Durable Object instance per token-room. Holds the live WebSocket
 * connections, keeps a registry of who is present, and relays WebRTC signals
 * between peers. Uses the WebSocket Hibernation API so idle rooms cost nothing.
 */
export class Room implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernatable accept: the DO can be evicted between messages and revived
    // on the next event, with serializeAttachment surviving across hibernation.
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const att: Attachment = {
        peerId: msg.peerId,
        role: msg.role,
        meta: msg.meta ?? null,
        lastSeen: Date.now(),
      };
      ws.serializeAttachment(att);
      this.send(ws, { type: "welcome", peerId: msg.peerId });
      this.broadcastPeers();
      void this.ensureSweep();
      return;
    }

    if (msg.type === "ping") {
      this.touch(ws);
      return;
    }

    if (msg.type === "meta") {
      const att = this.touch(ws);
      if (!att) return; // never said hello
      att.meta = msg.meta ?? null;
      ws.serializeAttachment(att);
      this.broadcastPeers();
      return;
    }

    if (msg.type === "signal") {
      const att = this.touch(ws);
      if (!att) return;
      const target = this.findByPeerId(msg.to);
      if (target) {
        this.send(target, { type: "signal", from: att.peerId, data: msg.data });
      }
      return;
    }
  }

  /** Periodic sweep: evict sockets that stopped heart-beating. Covers daemons
   *  killed with `kill -9`, whose WebSocket lingers in the room until the edge
   *  notices the dead TCP connection — otherwise they show as phantom servers. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let evicted = false;
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (att && now - att.lastSeen > STALE_MS) {
        try {
          ws.close(1001, "stale");
        } catch {
          // already closing
        }
        evicted = true;
      }
    }
    if (evicted) this.broadcastPeers();
    // Keep sweeping while anyone is connected; let idle rooms go quiet.
    if (this.state.getWebSockets().length > 0) {
      await this.state.storage.setAlarm(now + SWEEP_MS);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // already closing
    }
    this.broadcastPeers();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPeers();
  }

  // ---- helpers ----

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  /** Refresh a socket's liveness timestamp; returns its attachment if known. */
  private touch(ws: WebSocket): Attachment | null {
    const att = this.attachment(ws);
    if (!att) return null;
    att.lastSeen = Date.now();
    ws.serializeAttachment(att);
    return att;
  }

  /** Arm the sweep alarm if one isn't already pending. */
  private async ensureSweep(): Promise<void> {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + SWEEP_MS);
    }
  }

  private findByPeerId(peerId: string): WebSocket | null {
    for (const ws of this.state.getWebSockets()) {
      if (this.attachment(ws)?.peerId === peerId) return ws;
    }
    return null;
  }

  private peerList(): PeerInfo[] {
    const peers: PeerInfo[] = [];
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (att) peers.push({ peerId: att.peerId, role: att.role, meta: att.meta });
    }
    return peers;
  }

  private broadcastPeers(): void {
    const message: ServerMessage = { type: "peers", peers: this.peerList() };
    const payload = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // socket gone; will be cleaned up on close
      }
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // ignore
    }
  }
}
