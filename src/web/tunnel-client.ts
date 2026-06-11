import {
  type HttpResHead,
  Op,
  WsReassembler,
  chunk,
  decodeFrame,
  encodeFrame,
  encodeJson,
  payloadJson,
  payloadText,
  wsMessageFrames,
} from "../shared/protocol";

// Browser-side end of the tunnel. Owns the WebRTC data channel and multiplexes
// HTTP requests (driven by the Service Worker) and WebSocket connections
// (driven by the in-page TunnelWebSocket shim) over it by streamId.

interface HttpWaiter {
  onHead: (head: HttpResHead) => void;
  onBody: (chunk: Uint8Array) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

export interface TunnelWsHandlers {
  onOpenAck: (ok: boolean, protocol?: string) => void;
  onText: (text: string) => void;
  onBin: (data: Uint8Array) => void;
  onClose: (code: number, reason: string) => void;
}

export interface TunnelWsHandle {
  sendText: (text: string) => void;
  sendBin: (data: Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
}

/** The subset of a tunnel the Service Worker glue and WS shim depend on. Both
 *  the local {@link TunnelClient} and the cross-tab proxy implement it. */
export interface TunnelLike {
  fetch(method: string, path: string, headers: Record<string, string>, body?: Uint8Array): Promise<Response>;
  openWs(path: string, protocols: string[] | undefined, handlers: TunnelWsHandlers): TunnelWsHandle;
}

export class TunnelClient {
  private nextStreamId = 1;
  private https = new Map<number, HttpWaiter>();
  private wss = new Map<number, TunnelWsHandlers>();
  private wsRx = new WsReassembler(); // reassembles daemon -> browser WS messages
  private textEncoder = new TextEncoder();

  constructor(private channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", (ev) => this.onFrame(ev.data));
  }

  private allocId(): number {
    const id = this.nextStreamId;
    this.nextStreamId = (this.nextStreamId + 1) >>> 0 || 1;
    return id;
  }

  private onFrame(data: ArrayBuffer | string): void {
    if (typeof data === "string") return;
    const { op, streamId, payload } = decodeFrame(data);
    switch (op) {
      case Op.HttpResHead:
        this.https.get(streamId)?.onHead(payloadJson<HttpResHead>(payload));
        break;
      case Op.HttpResBody:
        this.https.get(streamId)?.onBody(payload.slice());
        break;
      case Op.HttpResEnd:
        this.https.get(streamId)?.onEnd();
        this.https.delete(streamId);
        break;
      case Op.Error: {
        const waiter = this.https.get(streamId);
        if (waiter) {
          waiter.onError(payloadJson<{ message: string }>(payload).message);
          this.https.delete(streamId);
        }
        break;
      }
      case Op.WsOpenAck: {
        const info = payloadJson<{ ok: boolean; protocol?: string }>(payload);
        this.wss.get(streamId)?.onOpenAck(info.ok, info.protocol);
        break;
      }
      case Op.WsCont:
        this.wsRx.cont(streamId, payload);
        break;
      case Op.WsText:
        this.wss.get(streamId)?.onText(payloadText(this.wsRx.finish(streamId, payload)));
        break;
      case Op.WsBin:
        this.wss.get(streamId)?.onBin(this.wsRx.finish(streamId, payload).slice());
        break;
      case Op.WsClose: {
        const info = payloadJson<{ code?: number; reason?: string }>(payload);
        this.wsRx.drop(streamId);
        this.wss.get(streamId)?.onClose(info.code ?? 1000, info.reason ?? "");
        this.wss.delete(streamId);
        break;
      }
    }
  }

  /** Perform an HTTP request over the tunnel; resolves to a Response. */
  fetch(method: string, path: string, headers: Record<string, string>, body?: Uint8Array): Promise<Response> {
    const streamId = this.allocId();
    return new Promise<Response>((resolve, reject) => {
      let head: HttpResHead | null = null;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });

      this.https.set(streamId, {
        onHead: (h) => {
          head = h;
          resolve(
            new Response(stream, {
              status: h.status === 204 || h.status === 304 ? h.status : h.status,
              statusText: h.statusText,
              headers: h.headers,
            }),
          );
        },
        onBody: (b) => {
          try {
            controller?.enqueue(b);
          } catch {
            // stream already closed/cancelled (consumer went away mid-body)
          }
        },
        onEnd: () => {
          try {
            controller?.close();
          } catch {
            // already closed
          }
          if (!head) reject(new Error("stream ended before head"));
        },
        onError: (msg) => {
          try {
            controller?.error(new Error(msg));
          } catch {
            // ignore
          }
          if (!head) reject(new Error(msg));
        },
      });

      this.send(encodeJson(Op.HttpReq, streamId, { method, path, headers }));
      if (body && body.byteLength) {
        for (const part of chunk(body)) this.send(encodeFrame(Op.HttpReqBody, streamId, part));
      }
      this.send(encodeFrame(Op.HttpReqEnd, streamId));
    });
  }

  /** Open a WebSocket stream over the tunnel; returns its streamId + a sender. */
  openWs(path: string, protocols: string[] | undefined, handlers: TunnelWsHandlers) {
    const streamId = this.allocId();
    this.wss.set(streamId, handlers);
    this.send(encodeJson(Op.WsOpen, streamId, { path, protocols }));
    return {
      sendText: (text: string) => {
        for (const f of wsMessageFrames(Op.WsText, streamId, this.textEncoder.encode(text))) this.send(f);
      },
      sendBin: (data: Uint8Array) => {
        for (const f of wsMessageFrames(Op.WsBin, streamId, data)) this.send(f);
      },
      close: (code?: number, reason?: string) => {
        this.send(encodeJson(Op.WsClose, streamId, { code, reason }));
        this.wss.delete(streamId);
      },
    };
  }

  private send(frame: Uint8Array): void {
    if (this.channel.readyState === "open") {
      // Copy into a fresh ArrayBuffer-backed view to satisfy send()'s typing.
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      this.channel.send(copy.buffer);
    }
  }

  get ready(): boolean {
    return this.channel.readyState === "open";
  }
}
