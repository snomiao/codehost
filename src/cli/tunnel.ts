import type { DataChannel } from "node-datachannel";
import {
  type HttpReqHead,
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

const textDecoder = new TextDecoder();

// Hop-by-hop headers that must not be forwarded across the tunnel.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

interface HttpStream {
  head: HttpReqHead;
  body: Uint8Array[];
}

/**
 * Bridges one WebRTC data channel to a local `code serve-web` instance.
 * Multiplexes concurrent HTTP requests and WebSocket connections by streamId.
 */
export class Tunnel {
  private httpStreams = new Map<number, HttpStream>();
  private wsConns = new Map<number, WebSocket>();
  private wsRx = new WsReassembler(); // reassembles browser -> daemon WS messages
  private origin: string; // e.g. http://127.0.0.1:11991
  private wsOrigin: string; // e.g. ws://127.0.0.1:11991

  constructor(
    private channel: DataChannel,
    private vscodePort: number,
  ) {
    this.origin = `http://127.0.0.1:${vscodePort}`;
    this.wsOrigin = `ws://127.0.0.1:${vscodePort}`;
    this.channel.onMessage((msg) => {
      if (typeof msg === "string") return; // all frames are binary
      const buf = msg as Buffer;
      void this.onFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    this.channel.onClosed(() => this.closeAll());
  }

  private async onFrame(data: Uint8Array): Promise<void> {
    const { op, streamId, payload } = decodeFrame(data);
    switch (op) {
      case Op.HttpReq:
        this.httpStreams.set(streamId, { head: payloadJson<HttpReqHead>(payload), body: [] });
        break;
      case Op.HttpReqBody:
        this.httpStreams.get(streamId)?.body.push(payload.slice());
        break;
      case Op.HttpReqEnd:
        await this.doHttp(streamId);
        break;
      case Op.WsOpen:
        this.openWs(streamId, payloadJson<{ path: string; protocols?: string[] }>(payload));
        break;
      case Op.WsCont:
        this.wsRx.cont(streamId, payload);
        break;
      case Op.WsText:
        this.wsConns.get(streamId)?.send(textDecoder.decode(this.wsRx.finish(streamId, payload)));
        break;
      case Op.WsBin:
        this.wsConns.get(streamId)?.send(this.wsRx.finish(streamId, payload));
        break;
      case Op.WsClose:
        this.wsRx.drop(streamId);
        this.wsConns.get(streamId)?.close();
        this.wsConns.delete(streamId);
        break;
    }
  }

  // ---- HTTP ----

  private async doHttp(streamId: number): Promise<void> {
    const stream = this.httpStreams.get(streamId);
    if (!stream) return;
    this.httpStreams.delete(streamId);

    const { method, path, headers } = stream.head;
    const reqHeaders = new Headers();
    let forwardedHost = "";
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (lk === "x-forwarded-host") {
        forwardedHost = v;
        continue;
      }
      if (!HOP_BY_HOP.has(lk)) reqHeaders.set(k, v);
    }
    // Present the browser's public host to VS Code so its client-side
    // remoteAuthority points at codehost.dev (routes resource URLs back through
    // the tunnel), not the unreachable 127.0.0.1:<port>. Falls back to the local
    // host if the SW didn't forward one.
    reqHeaders.set("host", forwardedHost || `127.0.0.1:${this.vscodePort}`);

    const hasBody = method !== "GET" && method !== "HEAD" && stream.body.length > 0;
    const body = hasBody ? concat(stream.body) : undefined;

    try {
      const res = await fetch(this.origin + path, {
        method,
        headers: reqHeaders,
        body: body as BodyInit | undefined,
        redirect: "manual",
      });

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
      });

      await this.send(
        encodeJson(Op.HttpResHead, streamId, {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
        }),
      );

      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const part of chunk(value)) {
            await this.send(encodeFrame(Op.HttpResBody, streamId, part));
          }
        }
      }
      await this.send(encodeFrame(Op.HttpResEnd, streamId));
    } catch (err) {
      await this.send(
        encodeJson(Op.Error, streamId, { message: `proxy error: ${String(err)}` }),
      );
    }
  }

  // ---- WebSocket ----

  private openWs(streamId: number, info: { path: string; protocols?: string[] }): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsOrigin + info.path, info.protocols);
    } catch (err) {
      void this.send(encodeJson(Op.WsOpenAck, streamId, { ok: false, error: String(err) }));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.wsConns.set(streamId, ws);

    ws.onopen = () => {
      void this.send(encodeJson(Op.WsOpenAck, streamId, { ok: true, protocol: ws.protocol }));
    };
    ws.onmessage = (ev: MessageEvent) => {
      const [terminal, u8] =
        typeof ev.data === "string"
          ? [Op.WsText, new TextEncoder().encode(ev.data)] as const
          : [Op.WsBin, ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBufferLike)] as const;
      for (const frame of wsMessageFrames(terminal, streamId, u8)) void this.send(frame);
    };
    ws.onclose = (ev: CloseEvent) => {
      void this.send(encodeJson(Op.WsClose, streamId, { code: ev.code, reason: ev.reason }));
      this.wsConns.delete(streamId);
    };
    ws.onerror = () => {
      void this.send(encodeJson(Op.WsClose, streamId, { code: 1006, reason: "error" }));
      this.wsConns.delete(streamId);
    };
  }

  // ---- send: serialized FIFO with backpressure ----

  // Frames must reach the channel in enqueue order (chunked bodies and
  // fragmented WS messages rely on it), but each send may pause for drain.
  // Chaining on `sendTail` preserves order even when callers don't await.
  private sendTail: Promise<void> = Promise.resolve();

  private send(frame: Uint8Array): Promise<void> {
    const p = this.sendTail.then(async () => {
      await this.waitForDrain();
      if (!this.channel.isOpen()) return;
      this.channel.sendMessageBinary(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    });
    this.sendTail = p.catch(() => {});
    return p;
  }

  private waitForDrain(): Promise<void> {
    const HIGH = 8 * 1024 * 1024; // 8 MB
    if (!this.channel.isOpen() || this.channel.bufferedAmount() < HIGH) return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => {
        if (!this.channel.isOpen() || this.channel.bufferedAmount() < HIGH) resolve();
        else setTimeout(tick, 10);
      };
      tick();
    });
  }

  closeAll(): void {
    for (const ws of this.wsConns.values()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.wsConns.clear();
    this.httpStreams.clear();
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
