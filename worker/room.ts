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
}

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
      };
      ws.serializeAttachment(att);
      this.send(ws, { type: "welcome", peerId: msg.peerId });
      this.broadcastPeers();
      return;
    }

    if (msg.type === "signal") {
      const from = this.attachment(ws)?.peerId;
      if (!from) return;
      const target = this.findByPeerId(msg.to);
      if (target) {
        this.send(target, { type: "signal", from, data: msg.data });
      }
      return;
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
