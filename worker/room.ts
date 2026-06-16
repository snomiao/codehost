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
  /** Wall-clock ms when this socket joined (sent `hello`); for the room roster. */
  since: number;
  /** Wall-clock ms of the last message from this socket (hello / ping / signal). */
  lastSeen: number;
}

/** How long a socket may go silent before eviction. Clients heartbeat every
 *  ~25s (HEARTBEAT_MS in signaling-client.ts); allow ~2 misses, so a crashed
 *  peer drops out within ~65s+. A hidden Chrome tab's throttled timers (1/min)
 *  must still beat STALE_MS, or background tabs churn evict/reconnect all day. */
const STALE_MS = 65_000;

/** The sweep alarm scans for dead sockets, and every firing is a billable DO
 *  request. A room with one always-on daemon never goes idle, so a fixed-cadence
 *  sweep would wake the DO forever — the dominant signaling cost. Instead the
 *  interval backs off exponentially with NO upper bound: it starts at
 *  SWEEP_MIN_MS so a just-changed room evicts promptly, doubles after every no-op
 *  sweep, and resets to the floor whenever a peer joins or a stale socket is
 *  evicted. So a long-stable room's sweep cost trends to zero — past
 *  SWEEP_STOP_MS it stops arming the alarm entirely. The trade-off: a
 *  hard-killed peer can then linger until the edge notices the dead socket or
 *  someone new joins the room (cosmetic — a graceful close still evicts
 *  immediately via webSocketClose). The interval is persisted (DO storage) so it
 *  survives hibernation between alarms. */
const SWEEP_MIN_MS = 20_000;
const SWEEP_MAX_MS = Infinity;
/** Overflow/sanity guard for the unbounded backoff: once the doubled interval
 *  passes a day, stop arming the sweep rather than hand setAlarm an ever-growing
 *  (eventually non-finite) timestamp. A peer join revives sweeping at the floor
 *  via ensureSweep, so phantom cleanup resumes whenever the room is used again. */
const SWEEP_STOP_MS = 24 * 60 * 60 * 1000;
const SWEEP_KEY = "sweepMs";

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
      const now = Date.now();
      const att: Attachment = {
        peerId: msg.peerId,
        role: msg.role,
        meta: msg.meta ?? null,
        since: now,
        lastSeen: now,
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
    // Idle room: stop sweeping and let the DO hibernate.
    if (this.state.getWebSockets().length === 0) return;
    // Stable sweep -> double the interval (capped); an eviction means the room is
    // changing, so reset to the floor and stay vigilant.
    const prev = (await this.state.storage.get<number>(SWEEP_KEY)) ?? SWEEP_MIN_MS;
    const next = evicted ? SWEEP_MIN_MS : Math.min(prev * 2, SWEEP_MAX_MS);
    await this.state.storage.put(SWEEP_KEY, next);
    // Unbounded backoff: past the stop horizon, leave the alarm unset — a long
    // stable room sweeps no more. A join (ensureSweep) or eviction revives it.
    if (next <= SWEEP_STOP_MS) {
      await this.state.storage.setAlarm(now + next);
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

  /** (Re)arm the sweep at the floor cadence. Called when a peer joins: a roster
   *  change should be re-checked promptly, so reset the backoff and pull the
   *  alarm in even if a (backed-off) one is already pending. */
  private async ensureSweep(): Promise<void> {
    await this.state.storage.put(SWEEP_KEY, SWEEP_MIN_MS);
    await this.state.storage.setAlarm(Date.now() + SWEEP_MIN_MS);
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
      if (att) peers.push({ peerId: att.peerId, role: att.role, meta: att.meta, since: att.since });
    }
    return peers;
  }

  private broadcastPeers(): void {
    const message: ServerMessage = { type: "peers", peers: this.peerList(), now: Date.now() };
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
