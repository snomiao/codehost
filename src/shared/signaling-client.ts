import {
  type ClientMessage,
  type PeerInfo,
  type PeerMeta,
  type Role,
  type ServerMessage,
  newPeerId,
} from "./signaling";

export interface SignalingClientOptions {
  /** Base signaling URL, e.g. wss://signal.codehost.dev */
  url: string;
  token: string;
  role: Role;
  meta?: PeerMeta;
  peerId?: string;
  onPeers?: (peers: PeerInfo[]) => void;
  onSignal?: (from: string, data: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * Thin WebSocket client for the signaling room. Runs unchanged in the browser
 * and in Bun (both expose a global `WebSocket`). Auto-reconnects with backoff
 * and re-sends `hello` on every (re)connect.
 */
export class SignalingClient {
  readonly peerId: string;
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 1000;

  constructor(private opts: SignalingClientOptions) {
    this.peerId = opts.peerId ?? newPeerId();
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private roomUrl(): string {
    const base = this.opts.url.replace(/\/+$/, "");
    return `${base}/room/${encodeURIComponent(this.opts.token)}`;
  }

  private open(): void {
    const ws = new WebSocket(this.roomUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      const hello: ClientMessage = {
        type: "hello",
        role: this.opts.role,
        peerId: this.peerId,
        ...(this.opts.meta ? { meta: this.opts.meta } : {}),
      };
      ws.send(JSON.stringify(hello));
      this.opts.onOpen?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "peers") this.opts.onPeers?.(msg.peers);
      else if (msg.type === "signal") this.opts.onSignal?.(msg.from, msg.data);
    };

    ws.onclose = () => {
      this.opts.onClose?.();
      if (!this.closed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 15000);
    setTimeout(() => {
      if (!this.closed) this.open();
    }, delay);
  }

  sendSignal(to: string, data: unknown): void {
    const msg: ClientMessage = { type: "signal", to, data };
    this.ws?.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}
