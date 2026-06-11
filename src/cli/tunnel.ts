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
  wsMessageFrames,
} from "../shared/protocol";

const textDecoder = new TextDecoder();

// Send-queue water marks. HIGH bounds how much data can sit ahead of an
// interactive message on the (single, ordered) channel — at 20 Mbps, 4 MB is
// already ~1.6 s of head-of-line latency, so resist raising it; LOW is where
// the bufferedAmountLow event resumes a paused sender.
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

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

/** A tunneled request offered to the daemon's local routes before proxying. */
export interface LocalRequest {
  method: string;
  /** Raw tunneled path incl. query (no /vs/<peerId> stripping applied). */
  path: string;
  headers: Headers;
  body?: Uint8Array;
}

/** Serve `/__codehost/*` requests in-daemon (provisioning, plugins). Return
 *  null/undefined to fall through to the local-server proxy. */
export type LocalHandler = (req: LocalRequest) => Promise<Response> | null | undefined;

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
    /**
     * Prefix to strip from incoming paths before forwarding to the local server.
     * VS Code is launched with --server-base-path /vs/<peerId> so it WANTS the
     * prefix (left undefined). An arbitrary exposed server (`codehost expose`)
     * doesn't know it, so we strip `/vs/<peerId>` before proxying.
     */
    private stripPrefix?: string,
    /** Serves `/__codehost/*` requests locally (provisioning, plugins) instead
     *  of forwarding to the local server. Wired only for `serve` (not `expose`). */
    private onLocal?: LocalHandler,
  ) {
    this.origin = `http://127.0.0.1:${vscodePort}`;
    this.wsOrigin = `ws://127.0.0.1:${vscodePort}`;
    try {
      this.channel.setBufferedAmountLowThreshold(LOW_WATER);
      this.channel.onBufferedAmountLow(() => this.drainWaiter?.());
    } catch {
      // older node-datachannel: the poll in waitForDrain still covers it
    }
    this.channel.onMessage((msg) => {
      if (typeof msg === "string") return; // all frames are binary
      const buf = msg as Buffer;
      void this.onFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    this.channel.onClosed(() => this.closeAll());
  }

  /** Map a tunneled path to the local server's path, stripping the base prefix. */
  private localPath(path: string): string {
    if (this.stripPrefix && path.startsWith(this.stripPrefix)) {
      const rest = path.slice(this.stripPrefix.length);
      return rest.startsWith("/") ? rest : `/${rest}`;
    }
    return path;
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

    // A client that can inflate (TunnelClient sends this marker) gets the
    // upstream's gzip bytes passed through UNTOUCHED — 3-4x fewer bytes over
    // the channel for VS Code's JS/CSS. gzip only: the browser inflates with
    // DecompressionStream, which has no brotli.
    const wantsGzip = reqHeaders.get("x-codehost-accept-gzip") === "1";
    reqHeaders.delete("x-codehost-accept-gzip");
    if (wantsGzip) reqHeaders.set("accept-encoding", "gzip");

    try {
      const local = this.onLocal?.({ method, path, headers: reqHeaders, body });
      const res = local
        ? await local
        : await fetch(this.origin + this.localPath(path), {
            method,
            headers: reqHeaders,
            body: body as BodyInit | undefined,
            redirect: "manual",
            // Bun extension: don't auto-inflate — keep the wire bytes compressed.
            ...(wantsGzip ? ({ decompress: false } as RequestInit) : {}),
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
      ws = new WebSocket(this.wsOrigin + this.localPath(info.path), info.protocols);
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

  // Fires from onBufferedAmountLow so a paused sender resumes the moment the
  // queue drains past LOW_WATER instead of on the next poll tick.
  private drainWaiter: (() => void) | null = null;

  private waitForDrain(): Promise<void> {
    if (!this.channel.isOpen() || this.channel.bufferedAmount() < HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.drainWaiter = null;
        resolve();
      };
      this.drainWaiter = finish;
      // Safety poll in case the low event raced or isn't available.
      const timer = setInterval(() => {
        if (!this.channel.isOpen() || this.channel.bufferedAmount() < HIGH_WATER) finish();
      }, 100);
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
