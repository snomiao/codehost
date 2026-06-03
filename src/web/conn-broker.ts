import { TunnelClient, type TunnelLike, type TunnelWsHandlers, type TunnelWsHandle } from "./tunnel-client";

// Per-tab connection broker. Talks to the SharedWorker (conn-shared-worker.ts)
// so that all tabs of this origin share ONE WebRTC data channel per server:
//
//   - Exactly one tab is the "owner" of a peerId; it holds the RTCPeerConnection
//     + data channel (RTCPeerConnection is Window-only) wrapped in a TunnelClient.
//   - Other tabs get a ProxyTunnelClient that routes fetch()/openWs() calls to
//     the owner through the SharedWorker and streams the answers back.
//   - If the owner tab goes away, the SharedWorker promotes another tab, which
//     re-establishes the connection (failover).
//
// tunnelFor(peerId) returns the right TunnelLike for this tab transparently, so
// the Service Worker glue and the WS shim don't know or care who owns what.

type AnyMsg = Record<string, any>;

/** Creates the RTCPeerConnection for a peer and resolves with its open channel.
 *  Provided by the UI (discovery.tsx) and invoked only when this tab is owner. */
export type Establish = () => Promise<RTCDataChannel>;

class ConnBroker {
  private port: MessagePort | null = null;
  private tabId = 0;
  private supported = false;

  private locals = new Map<string, TunnelClient>(); // peerId -> owner-held channel
  private proxies = new Map<string, ProxyTunnelClient>(); // peerId -> cross-tab proxy
  private establishers = new Map<string, Establish>(); // peerId -> how to (re)connect
  private establishing = new Set<string>(); // peerIds whose channel is opening
  private remoteReady = new Set<string>(); // peerIds served by a remote owner
  private readyWaiters = new Map<string, Array<() => void>>();
  private pending = new Map<number, (payload: AnyMsg) => void>(); // requester: callId -> sink
  private ownerWs = new Map<string, TunnelWsHandle>(); // owner: `${tab}:${callId}` -> ws
  private callSeq = 1;
  private lostCb: ((peerId: string) => void) | null = null;

  init(): void {
    try {
      const worker = new SharedWorker(new URL("./conn-shared-worker.ts", import.meta.url), {
        type: "module",
        name: "codehost-conn",
      });
      this.port = worker.port;
      this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
      this.port.start();
      this.post({ t: "hello" });
      setInterval(() => this.post({ t: "ping" }), 4000);
      addEventListener("pagehide", () => this.post({ t: "bye" }));
      this.supported = true;
      (globalThis as Record<string, unknown>).__connBroker = this; // debug handle

    } catch (err) {
      // No SharedWorker (or blocked): fall back to single-tab ownership.
      console.warn("[codehost] SharedWorker unavailable; per-tab connections", err);
      this.supported = false;
    }
  }

  /** Notified when a remote owner vanished, so the UI can reload the iframe. */
  onLost(cb: (peerId: string) => void): void {
    this.lostCb = cb;
  }

  /** Establish (or attach to) the shared connection for a server. Resolves once
   *  the tunnel is usable from this tab (local channel open, or owner ready). */
  async connect(peerId: string, establish: Establish): Promise<void> {
    this.establishers.set(peerId, establish);
    if (!this.supported || !this.port) {
      await this.becomeOwner(peerId);
      return;
    }
    const ready = this.waitReady(peerId);
    this.post({ t: "acquire", peerId });
    // If the SharedWorker never assigns a role (silent/unsupported), don't hang
    // forever — open a direct connection so this tab still works on its own.
    const fallback = setTimeout(() => {
      if (!this.locals.has(peerId) && !this.remoteReady.has(peerId) && !this.establishing.has(peerId)) {
        console.warn("[codehost] broker coordination timed out; opening direct connection");
        void this.becomeOwner(peerId);
      }
    }, 2500);
    await ready;
    clearTimeout(fallback);
  }

  tunnelFor(peerId: string): TunnelLike {
    const local = this.locals.get(peerId);
    if (local) return local;
    let proxy = this.proxies.get(peerId);
    if (!proxy) {
      proxy = new ProxyTunnelClient(peerId, this);
      this.proxies.set(peerId, proxy);
    }
    return proxy;
  }

  disconnect(peerId: string): void {
    this.post({ t: "release", peerId });
    this.locals.delete(peerId);
    this.proxies.delete(peerId);
    this.establishers.delete(peerId);
  }

  // ---- ownership ----

  private async becomeOwner(peerId: string): Promise<void> {
    if (this.locals.has(peerId) || this.establishing.has(peerId)) return;
    const establish = this.establishers.get(peerId);
    if (!establish) return;
    this.establishing.add(peerId);
    try {
      const channel = await establish();
      this.locals.set(peerId, new TunnelClient(channel));
      this.post({ t: "ready", peerId });
      this.resolveReady(peerId);
    } catch (err) {
      console.error("[codehost] failed to establish owner connection", err);
    } finally {
      this.establishing.delete(peerId);
    }
  }

  private waitReady(peerId: string): Promise<void> {
    if (this.locals.has(peerId)) return Promise.resolve();
    return new Promise((resolve) => {
      const arr = this.readyWaiters.get(peerId) ?? [];
      arr.push(resolve);
      this.readyWaiters.set(peerId, arr);
    });
  }

  private resolveReady(peerId: string): void {
    const arr = this.readyWaiters.get(peerId);
    if (!arr) return;
    this.readyWaiters.delete(peerId);
    for (const resolve of arr) resolve();
  }

  // ---- SharedWorker wire ----

  private post(msg: AnyMsg): void {
    this.port?.postMessage(msg);
  }

  private onMessage(msg: AnyMsg): void {
    switch (msg.t) {
      case "welcome":
        this.tabId = msg.tabId;
        break;
      case "role":
        if (msg.owner) void this.becomeOwner(msg.peerId);
        break; // non-owner waits for "ready"
      case "ready":
        if (!this.locals.has(msg.peerId)) this.remoteReady.add(msg.peerId);
        this.resolveReady(msg.peerId);
        break;
      case "promoted": // failover: we are the new owner
        this.remoteReady.delete(msg.peerId);
        this.locals.delete(msg.peerId);
        void this.becomeOwner(msg.peerId);
        break;
      case "owner-gone": // a remote owner left; drop proxy + ask UI to reload
        this.remoteReady.delete(msg.peerId);
        this.proxies.delete(msg.peerId);
        this.lostCb?.(msg.peerId);
        break;
      case "rpc":
        this.serveRpc(msg); // owner side
        break;
      case "rpc-reply":
        this.pending.get(msg.callId)?.(msg.payload); // requester side
        break;
    }
  }

  // ---- requester side (used by ProxyTunnelClient) ----

  nextCall(): number {
    return this.callSeq++;
  }
  registerCall(callId: number, sink: (payload: AnyMsg) => void): void {
    this.pending.set(callId, sink);
  }
  endCall(callId: number): void {
    this.pending.delete(callId);
  }
  sendRpc(peerId: string, callId: number, payload: AnyMsg): void {
    this.post({ t: "rpc", peerId, callId, payload });
  }

  // ---- owner side: run a routed call against the local TunnelClient ----

  private serveRpc(msg: AnyMsg): void {
    const local = this.locals.get(msg.peerId);
    const reply = (payload: AnyMsg) =>
      this.post({ t: "rpc-reply", peerId: msg.peerId, callId: msg.callId, toTabId: msg.fromTabId, payload });
    if (!local) {
      reply({ op: "error", message: "owner has no channel" });
      return;
    }
    const p = msg.payload as AnyMsg;
    const wsKey = `${msg.fromTabId}:${msg.callId}`;
    switch (p.op) {
      case "fetch":
        void local
          .fetch(p.method, p.path, p.headers, p.body ? new Uint8Array(p.body) : undefined)
          .then(async (res) => {
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => (headers[k] = v));
            reply({ op: "head", status: res.status, statusText: res.statusText, headers });
            if (res.body) {
              const reader = res.body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                reply({ op: "body", chunk: toBuffer(value) });
              }
            }
            reply({ op: "end" });
          })
          .catch((err) => reply({ op: "error", message: String(err) }));
        break;
      case "ws-open": {
        const handle = local.openWs(p.path, p.protocols, {
          onOpenAck: (ok, protocol) => reply({ op: "ws-openack", ok, protocol }),
          onText: (text) => reply({ op: "ws-rtext", data: text }),
          onBin: (data) => reply({ op: "ws-rbin", data: toBuffer(data) }),
          onClose: (code, reason) => {
            reply({ op: "ws-rclose", code, reason });
            this.ownerWs.delete(wsKey);
          },
        });
        this.ownerWs.set(wsKey, handle);
        break;
      }
      case "ws-text":
        this.ownerWs.get(wsKey)?.sendText(p.data);
        break;
      case "ws-bin":
        this.ownerWs.get(wsKey)?.sendBin(new Uint8Array(p.data));
        break;
      case "ws-close":
        this.ownerWs.get(wsKey)?.close(p.code, p.reason);
        this.ownerWs.delete(wsKey);
        break;
    }
  }
}

/** A TunnelLike that forwards every call to the owner tab via the SharedWorker. */
class ProxyTunnelClient implements TunnelLike {
  constructor(
    private peerId: string,
    private broker: ConnBroker,
  ) {}

  fetch(method: string, path: string, headers: Record<string, string>, body?: Uint8Array): Promise<Response> {
    const callId = this.broker.nextCall();
    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let settled = false;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
      this.broker.registerCall(callId, (payload) => {
        switch (payload.op) {
          case "head":
            settled = true;
            resolve(new Response(stream, { status: payload.status, statusText: payload.statusText, headers: payload.headers }));
            break;
          case "body":
            controller?.enqueue(new Uint8Array(payload.chunk));
            break;
          case "end":
            try {
              controller?.close();
            } catch {
              /* already closed */
            }
            this.broker.endCall(callId);
            break;
          case "error":
            if (!settled) reject(new Error(payload.message));
            else
              try {
                controller?.error(new Error(payload.message));
              } catch {
                /* ignore */
              }
            this.broker.endCall(callId);
            break;
        }
      });
      this.broker.sendRpc(this.peerId, callId, { op: "fetch", method, path, headers, body: body ? toBuffer(body) : undefined });
    });
  }

  openWs(path: string, protocols: string[] | undefined, handlers: TunnelWsHandlers): TunnelWsHandle {
    const callId = this.broker.nextCall();
    this.broker.registerCall(callId, (payload) => {
      switch (payload.op) {
        case "ws-openack":
          handlers.onOpenAck(payload.ok, payload.protocol);
          break;
        case "ws-rtext":
          handlers.onText(payload.data);
          break;
        case "ws-rbin":
          handlers.onBin(new Uint8Array(payload.data));
          break;
        case "ws-rclose":
          handlers.onClose(payload.code ?? 1000, payload.reason ?? "");
          this.broker.endCall(callId);
          break;
      }
    });
    this.broker.sendRpc(this.peerId, callId, { op: "ws-open", path, protocols });
    return {
      sendText: (text) => this.broker.sendRpc(this.peerId, callId, { op: "ws-text", data: text }),
      sendBin: (data) => this.broker.sendRpc(this.peerId, callId, { op: "ws-bin", data: toBuffer(data) }),
      close: (code, reason) => {
        this.broker.sendRpc(this.peerId, callId, { op: "ws-close", code, reason });
        this.broker.endCall(callId);
      },
    };
  }
}

/** Copy a view's bytes into a standalone ArrayBuffer (safe to structured-clone). */
function toBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export const connBroker = new ConnBroker();
