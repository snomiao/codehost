import {
  type HttpReqHead,
  Op,
  WsReassembler,
  chunk,
  concatBytes,
  decodeFrame,
  encodeFrame,
  encodeJson,
  payloadJson,
  wsMessageFrames,
} from "./protocol";
import type { TunnelTransport } from "./transport";

const textDecoder = new TextDecoder();

// Send-queue water marks. HIGH bounds how much data can sit ahead of an
// interactive message on the (single, ordered) transport — at 20 Mbps, 4 MB is
// already ~1.6 s of head-of-line latency, so resist raising it; LOW is where
// the buffered-amount-low event resumes a paused sender.
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

/** A tunneled request offered to the host's local routes before proxying. */
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

export interface TunnelHostOptions {
  /** Loopback port of the local server to proxy to. */
  port: number;
  /**
   * Prefix to strip from incoming paths before forwarding to the local server.
   * VS Code is launched with --server-base-path /vs/<peerId> so it WANTS the
   * prefix (left undefined). An arbitrary exposed server (`codehost expose`)
   * doesn't know it, so we strip `/vs/<peerId>` before proxying.
   */
  stripPrefix?: string;
  /** Serves `/__codehost/*` requests locally (provisioning, plugins) instead
   *  of forwarding to the local server. Wired only for `serve` (not `expose`). */
  onLocal?: LocalHandler;
}

/**
 * Server half of the tunnel: bridges one transport to a local HTTP/WS server
 * on 127.0.0.1. Multiplexes concurrent HTTP requests and WebSocket
 * connections by streamId.
 */
export class TunnelHost {
  private httpStreams = new Map<number, HttpStream>();
  private wsConns = new Map<number, WebSocket>();
  private wsRx = new WsReassembler(); // reassembles client -> host WS messages
  private origin: string; // e.g. http://127.0.0.1:11991
  private wsOrigin: string; // e.g. ws://127.0.0.1:11991
  private port: number;
  private stripPrefix?: string;
  private onLocal?: LocalHandler;

  constructor(
    private transport: TunnelTransport,
    opts: TunnelHostOptions,
  ) {
    this.port = opts.port;
    this.stripPrefix = opts.stripPrefix;
    this.onLocal = opts.onLocal;
    this.origin = `http://127.0.0.1:${opts.port}`;
    this.wsOrigin = `ws://127.0.0.1:${opts.port}`;
    transport.setBufferedAmountLow?.(LOW_WATER, () => this.drainWaiter?.());
    transport.onFrame((data) => void this.onFrame(data));
    transport.onClose(() => this.closeAll());
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
        // finish() is widened to Uint8Array<ArrayBufferLike>; it's always
        // ArrayBuffer-backed at runtime, so narrow it for the strict send() type.
        this.wsConns.get(streamId)?.send(this.wsRx.finish(streamId, payload) as Uint8Array<ArrayBuffer>);
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
    reqHeaders.set("host", forwardedHost || `127.0.0.1:${this.port}`);

    const hasBody = method !== "GET" && method !== "HEAD" && stream.body.length > 0;
    const body = hasBody ? concatBytes(stream.body) : undefined;

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

      // The body we forward is DECODED unless we're on the gzip-passthrough path
      // (a client that opted in AND a direct upstream fetch with decompress:false).
      // Everywhere else — the default fetch here, and every `onLocal` plugin
      // (e.g. the port-preview proxy) — Bun already auto-inflated the bytes, so a
      // stale `content-encoding: gzip` would make the client inflate plain bytes
      // and blow up (Z_DATA_ERROR). Keep the header only when the bytes are still
      // compressed on the wire.
      const gzipPassthrough = wantsGzip && !local;
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) return;
        if (lk === "content-encoding" && !gzipPassthrough) return;
        resHeaders[k] = v;
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
    // Preview WS (the `port` plugin's WS counterpart): a path under
    // /__codehost/port/<PORT>/ targets that loopback port, so a proxied dev
    // server's WebSocket (e.g. Vite HMR) rides the tunnel to 127.0.0.1:<PORT>.
    let target = this.wsOrigin + this.localPath(info.path);
    const pm = /^\/__codehost\/port\/(\d{1,5})(\/.*)?$/.exec(info.path);
    if (pm) target = `ws://127.0.0.1:${pm[1]}${pm[2] || "/"}`;
    try {
      ws = new WebSocket(target, info.protocols);
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

  // Frames must reach the transport in enqueue order (chunked bodies and
  // fragmented WS messages rely on it), but each send may pause for drain.
  // Chaining on `sendTail` preserves order even when callers don't await.
  private sendTail: Promise<void> = Promise.resolve();

  private send(frame: Uint8Array): Promise<void> {
    const p = this.sendTail.then(async () => {
      await this.waitForDrain();
      if (!this.transport.isOpen()) return;
      this.transport.send(frame);
    });
    this.sendTail = p.catch(() => {});
    return p;
  }

  // Fires from the buffered-amount-low callback so a paused sender resumes the
  // moment the queue drains past LOW_WATER instead of on the next poll tick.
  private drainWaiter: (() => void) | null = null;

  private waitForDrain(): Promise<void> {
    if (!this.transport.isOpen() || this.transport.bufferedAmount() < HIGH_WATER) return Promise.resolve();
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
        if (!this.transport.isOpen() || this.transport.bufferedAmount() < HIGH_WATER) finish();
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
