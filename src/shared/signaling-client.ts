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
  /** Called on every socket close. `info` carries the WebSocket close code,
   *  reason, and how long the socket stayed open (ms) — for diagnosing networks
   *  that complete the upgrade then drop the connection. */
  onClose?: (info?: CloseInfo) => void;
}

export interface CloseInfo {
  code: number;
  reason: string;
  /** Milliseconds the socket was open before it closed. */
  ms: number;
}

/** Reset the reconnect backoff only after a socket has stayed open this long. A
 *  connection that completes the handshake then drops within seconds (a
 *  middlebox that accepts the WebSocket upgrade but kills the socket, seen on
 *  some field networks) must keep backing off — otherwise every reset-to-1s
 *  open/close cycle becomes a sub-second reconnect storm. */
const STABLE_MS = 10_000;

/** Abort a connect attempt that hasn't opened by this deadline. Observed in the
 *  field (Chrome, page-load burst): a socket can sit in CONNECTING for minutes
 *  and never fire close — so without this, no retry ever runs, even though a
 *  freshly-created socket to the same room opens instantly. */
const CONNECT_TIMEOUT_MS = 10_000;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Fires STABLE_MS after a socket opens; only then is the backoff reset. */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock ms when the current socket opened (0 if never/closed). */
  private openedAt = 0;

  constructor(private opts: SignalingClientOptions) {
    this.peerId = opts.peerId ?? newPeerId();
  }

  connect(): void {
    this.closed = false;
    this.attachWakeListeners();
    this.open();
  }

  // ---- background-tab recovery -------------------------------------------
  // Chrome throttles timers in hidden tabs to minutes, so the backoff retry
  // (and the connect-timeout abort) may be arbitrarily far away even though a
  // fresh socket would connect in milliseconds. When the tab becomes visible /
  // focused / back online, recover NOW instead of waiting for a timer.

  private onWake = (): void => {
    if (this.closed) return;
    const state = this.ws?.readyState;
    if (state === 1 /* OPEN */) return;
    if (state === 0 /* CONNECTING */) {
      // Stuck handshake: abort — onclose reschedules, and timers run normally
      // now that the tab is active.
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
      return;
    }
    // Closed and waiting out the (throttled) backoff: skip the wait.
    if (this.reconnectTimer != null) {
      this.clearReconnectTimer();
      this.open();
    }
  };

  private attachWakeListeners(): void {
    const doc = (globalThis as { document?: EventTarget }).document;
    doc?.addEventListener("visibilitychange", this.onWake);
    const win = (globalThis as { window?: EventTarget }).window;
    win?.addEventListener("focus", this.onWake);
    win?.addEventListener("online", this.onWake);
  }

  private detachWakeListeners(): void {
    const doc = (globalThis as { document?: EventTarget }).document;
    doc?.removeEventListener("visibilitychange", this.onWake);
    const win = (globalThis as { window?: EventTarget }).window;
    win?.removeEventListener("focus", this.onWake);
    win?.removeEventListener("online", this.onWake);
  }

  private roomUrl(): string {
    const base = this.opts.url.replace(/\/+$/, "");
    return `${base}/room/${encodeURIComponent(this.opts.token)}`;
  }

  private open(): void {
    const ws = new WebSocket(this.roomUrl());
    this.ws = ws;

    // A stuck CONNECTING socket never fires close on its own — abort it so the
    // normal onclose -> backoff -> retry path takes over.
    const connectTimer = setTimeout(() => {
      if (ws.readyState === 0 /* CONNECTING */) {
        try {
          ws.close();
        } catch {
          // closing an unopened socket may throw in some runtimes — the
          // onerror/onclose path still runs
        }
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      this.openedAt = Date.now();
      // Don't reset the backoff yet — only once the socket proves stable (see
      // STABLE_MS). A handshake-then-drop network never reaches this timer, so
      // its backoff keeps growing instead of hammering at 1s.
      this.clearStableTimer();
      this.stableTimer = setTimeout(() => {
        this.reconnectDelay = 1000;
      }, STABLE_MS);
      const hello: ClientMessage = {
        type: "hello",
        role: this.opts.role,
        peerId: this.peerId,
        ...(this.opts.meta ? { meta: this.opts.meta } : {}),
      };
      ws.send(JSON.stringify(hello));
      this.startHeartbeat();
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

    ws.onclose = (ev) => {
      clearTimeout(connectTimer);
      this.clearStableTimer();
      this.stopHeartbeat();
      const ms = this.openedAt ? Date.now() - this.openedAt : 0;
      this.openedAt = 0;
      this.opts.onClose?.({ code: ev?.code ?? 0, reason: ev?.reason ?? "", ms });
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

  // Heartbeat keeps the room's liveness sweep from evicting us. At 10s, the DO
  // (STALE_MS 35s) tolerates ~3 missed beats before treating us as gone — fast
  // enough that a crashed peer stops showing as a phantom server within ~1 sweep.
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping" }));
      } catch {
        // socket gone; onclose will reconnect
      }
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat != null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer != null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 15000);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  sendSignal(to: string, data: unknown): void {
    const msg: ClientMessage = { type: "signal", to, data };
    this.ws?.send(JSON.stringify(msg));
  }

  /** Replace the advertised metadata: a live socket pushes it to the room now,
   *  and every future (re)connect's `hello` carries it. */
  updateMeta(meta: PeerMeta): void {
    this.opts.meta = meta;
    if (this.ws?.readyState === 1 /* OPEN */) {
      const msg: ClientMessage = { type: "meta", meta };
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closed = true;
    this.detachWakeListeners();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStableTimer();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}
