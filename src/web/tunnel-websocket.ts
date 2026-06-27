import type { TunnelLike, TunnelWsHandle } from "./tunnel-client";

// Minimal WebSocket implementation backed by a TunnelClient stream. Installed
// into the VS Code iframe as `window.WebSocket` so the workbench's socket
// connections traverse the WebRTC data channel instead of the network.
//
// Only the surface VS Code uses is implemented: readyState, binaryType, send,
// close, and the onopen/onmessage/onclose/onerror + addEventListener events.

type Listener = (ev: any) => void;

export function makeTunnelWebSocket(client: TunnelLike, basePath: string) {
  return class TunnelWebSocket implements Partial<WebSocket> {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    url: string;
    readyState: 0 | 1 | 2 | 3 = 0;
    binaryType: BinaryType = "blob";
    protocol = "";

    onopen: Listener | null = null;
    onmessage: Listener | null = null;
    onclose: Listener | null = null;
    onerror: Listener | null = null;

    private listeners = new Map<string, Set<Listener>>();
    private handle: TunnelWsHandle;

    constructor(url: string | URL, protocols?: string | string[]) {
      this.url = String(url);
      const u = new URL(this.url, self.location.href);
      // Forward only the path+query relative to the server base path.
      let path = u.pathname + u.search;
      if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length) || "/";
      const protoList = protocols ? (Array.isArray(protocols) ? protocols : [protocols]) : undefined;

      this.handle = client.openWs(basePath + path, protoList, {
        onOpenAck: (ok, protocol) => {
          if (!ok) {
            this.fail();
            return;
          }
          this.readyState = 1;
          this.protocol = protocol ?? "";
          this.dispatch("open", {});
        },
        onText: (text) => this.dispatch("message", { data: text }),
        onBin: (data) => this.dispatch("message", { data: this.wrapBinary(data) }),
        onClose: (code, reason) => {
          this.readyState = 3;
          this.dispatch("close", { code, reason, wasClean: code === 1000 });
        },
      });
    }

    private wrapBinary(data: Uint8Array): ArrayBuffer | Blob {
      if (this.binaryType === "arraybuffer") {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      }
      return new Blob([data as BlobPart]);
    }

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      if (this.readyState !== 1) return;
      if (typeof data === "string") {
        this.handle.sendText(data);
      } else if (data instanceof Blob) {
        void data.arrayBuffer().then((b) => this.handle.sendBin(new Uint8Array(b)));
      } else if (ArrayBuffer.isView(data)) {
        this.handle.sendBin(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else {
        this.handle.sendBin(new Uint8Array(data as ArrayBuffer));
      }
    }

    close(code?: number, reason?: string): void {
      if (this.readyState === 3) return;
      this.readyState = 2;
      this.handle.close(code, reason);
      this.readyState = 3;
      this.dispatch("close", { code: code ?? 1000, reason: reason ?? "", wasClean: true });
    }

    private fail(): void {
      this.readyState = 3;
      this.dispatch("error", {});
      this.dispatch("close", { code: 1006, reason: "tunnel open failed", wasClean: false });
    }

    addEventListener(type: string, listener: Listener): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    private dispatch(type: string, init: Record<string, unknown>): void {
      const ev = { type, target: this, ...init };
      const handler = (this as any)[`on${type}`] as Listener | null;
      handler?.call(this, ev);
      this.listeners.get(type)?.forEach((l) => l.call(this, ev));
    }
  };
}
