import { afterAll, describe, expect, test } from "bun:test";
import { TunnelClient } from "./client";
import { TunnelHost } from "./host";
import {
  MAX_CHUNK,
  Op,
  WsReassembler,
  chunk,
  decodeFrame,
  encodeFrame,
  encodeJson,
  payloadJson,
  wsMessageFrames,
} from "./protocol";
import { memoryTransportPair } from "./testing";

// ---- codec ----

describe("codec", () => {
  test("frame round-trip", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = encodeFrame(Op.HttpResBody, 0xdeadbeef, payload);
    const dec = decodeFrame(frame);
    expect(dec.op).toBe(Op.HttpResBody);
    expect(dec.streamId).toBe(0xdeadbeef);
    expect([...dec.payload]).toEqual([...payload]);
  });

  test("json round-trip", () => {
    const obj = { method: "GET", path: "/a?b=1", headers: { "x-y": "z" } };
    const dec = decodeFrame(encodeJson(Op.HttpReq, 7, obj));
    expect(payloadJson<typeof obj>(dec.payload)).toEqual(obj);
  });

  test("chunk splits at MAX_CHUNK and preserves bytes", () => {
    const body = new Uint8Array(MAX_CHUNK * 2 + 17).map((_, i) => i & 0xff);
    const parts = [...chunk(body)];
    expect(parts.length).toBe(3);
    expect(parts[0].byteLength).toBe(MAX_CHUNK);
    expect(parts[2].byteLength).toBe(17);
    expect(Buffer.concat(parts)).toEqual(Buffer.from(body));
  });

  test("ws fragmentation reassembles across WsCont frames", () => {
    const msg = new Uint8Array(MAX_CHUNK * 2 + 5).map((_, i) => (i * 7) & 0xff);
    const frames = [...wsMessageFrames(Op.WsBin, 3, msg)];
    expect(frames.length).toBe(3);
    const rx = new WsReassembler();
    let out: Uint8Array | null = null;
    for (const f of frames) {
      const { op, streamId, payload } = decodeFrame(f);
      if (op === Op.WsCont) rx.cont(streamId, payload);
      else out = rx.finish(streamId, payload);
    }
    expect(Buffer.from(out!)).toEqual(Buffer.from(msg));
  });

  test("single-frame ws message needs no WsCont", () => {
    const frames = [...wsMessageFrames(Op.WsText, 1, new Uint8Array(10))];
    expect(frames.length).toBe(1);
    expect(decodeFrame(frames[0]).op).toBe(Op.WsText);
  });
});

// ---- end-to-end over an in-memory transport pair ----

const gzip = (s: string) => Bun.gzipSync(Buffer.from(s));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("no upgrade", { status: 400 });
    }
    if (url.pathname === "/hello") {
      return new Response(`hi ${url.searchParams.get("name") ?? "?"} host=${req.headers.get("host")}`, {
        headers: { "x-served-by": "test" },
      });
    }
    if (url.pathname === "/echo") {
      return (async () => {
        const body = new Uint8Array(await req.arrayBuffer());
        let sum = 0;
        for (const b of body) sum = (sum + b) & 0xffff;
        return Response.json({ len: body.byteLength, sum });
      })();
    }
    if (url.pathname === "/gz") {
      return new Response(gzip("hello gzip world"), {
        headers: { "content-encoding": "gzip", "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/big") {
      const body = new Uint8Array(MAX_CHUNK * 3 + 123).map((_, i) => (i * 13) & 0xff);
      return new Response(body);
    }
    return new Response(`path:${url.pathname}${url.search}`, { status: url.pathname === "/missing" ? 404 : 200 });
  },
  websocket: {
    message(ws, message) {
      ws.send(message); // echo
    },
  },
});
afterAll(() => server.stop(true));

function connect(opts: { stripPrefix?: string; onLocal?: ConstructorParameters<typeof TunnelHost>[1]["onLocal"] } = {}) {
  const [hostSide, clientSide] = memoryTransportPair();
  const host = new TunnelHost(hostSide, { port: server.port!, ...opts });
  const client = new TunnelClient(clientSide);
  return { host, client, hostSide, clientSide };
}

describe("http over the tunnel", () => {
  test("GET: status, headers, body, forwarded host", async () => {
    const { client } = connect();
    const res = await client.fetch("GET", "/hello?name=sno", { "x-forwarded-host": "x.example.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-served-by")).toBe("test");
    expect(await res.text()).toBe("hi sno host=x.example.com");
  });

  test("POST body larger than one frame arrives whole", async () => {
    const { client } = connect();
    const body = new Uint8Array(MAX_CHUNK * 2 + 99).map((_, i) => (i * 31) & 0xff);
    let sum = 0;
    for (const b of body) sum = (sum + b) & 0xffff;
    const res = await client.fetch("POST", "/echo", {}, body);
    expect(await res.json()).toEqual({ len: body.byteLength, sum });
  });

  test("response larger than one frame arrives whole", async () => {
    const { client } = connect();
    const res = await client.fetch("GET", "/big", {});
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.byteLength).toBe(MAX_CHUNK * 3 + 123);
    expect(got[MAX_CHUNK * 3 + 100]).toBe(((MAX_CHUNK * 3 + 100) * 13) & 0xff);
  });

  test("gzip passthrough: client inflates and strips content-encoding", async () => {
    const { client } = connect();
    const res = await client.fetch("GET", "/gz", {});
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("hello gzip world");
  });

  test("404 passes through", async () => {
    const { client } = connect();
    const res = await client.fetch("GET", "/missing", {});
    expect(res.status).toBe(404);
  });

  test("stripPrefix removes the base path before proxying", async () => {
    const { client } = connect({ stripPrefix: "/vs/abc123" });
    const res = await client.fetch("GET", "/vs/abc123/deep/path?q=1", {});
    expect(await res.text()).toBe("path:/deep/path?q=1");
  });

  test("onLocal intercepts before the proxy", async () => {
    const { client } = connect({
      onLocal: (req) => (req.path.startsWith("/__local") ? Promise.resolve(new Response(`local:${req.method}`)) : undefined),
    });
    expect(await (await client.fetch("GET", "/__local/x", {})).text()).toBe("local:GET");
    expect(await (await client.fetch("GET", "/hello?name=a", {})).text()).toContain("hi a");
  });

  test("unreachable upstream rejects the fetch", async () => {
    const [hostSide, clientSide] = memoryTransportPair();
    new TunnelHost(hostSide, { port: 1 }); // nothing listens on port 1
    const client = new TunnelClient(clientSide);
    await expect(client.fetch("GET", "/x", {})).rejects.toThrow(/proxy error/);
  });

  test("concurrent requests multiplex without crosstalk", async () => {
    const { client } = connect();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => client.fetch("GET", `/hello?name=n${i}`, {}).then((r) => r.text())),
    );
    results.forEach((text, i) => expect(text).toContain(`hi n${i}`));
  });
});

describe("websocket over the tunnel", () => {
  function openEchoWs(client: TunnelClient) {
    const texts: string[] = [];
    const bins: Uint8Array[] = [];
    let opened: (ok: boolean) => void;
    const openAck = new Promise<boolean>((r) => (opened = r));
    let onNext: (() => void) | null = null;
    const handle = client.openWs("/ws", undefined, {
      onOpenAck: (ok) => opened(ok),
      onText: (t) => {
        texts.push(t);
        onNext?.();
      },
      onBin: (b) => {
        bins.push(b);
        onNext?.();
      },
      onClose: () => {},
    });
    const waitMessage = () => new Promise<void>((r) => (onNext = () => r()));
    return { handle, openAck, texts, bins, waitMessage };
  }

  test("open, echo text, echo large binary (fragmented)", async () => {
    const { client } = connect();
    const ws = openEchoWs(client);
    expect(await ws.openAck).toBe(true);

    let wait = ws.waitMessage();
    ws.handle.sendText("ping");
    await wait;
    expect(ws.texts).toEqual(["ping"]);

    const big = new Uint8Array(MAX_CHUNK * 2 + 42).map((_, i) => (i * 3) & 0xff);
    wait = ws.waitMessage();
    ws.handle.sendBin(big);
    await wait;
    expect(ws.bins.length).toBe(1);
    expect(Buffer.from(ws.bins[0])).toEqual(Buffer.from(big));
  });

  test("a /__codehost/port/<PORT>/ path targets that loopback port (preview WS)", async () => {
    // Host is configured for a dead port (1); the preview prefix must override
    // it and reach the real echo server on server.port.
    const [hostSide, clientSide] = memoryTransportPair();
    new TunnelHost(hostSide, { port: 1 });
    const client = new TunnelClient(clientSide);
    const echoed = await new Promise<string>((resolve, reject) => {
      const handle = client.openWs(`/__codehost/port/${server.port}/ws`, undefined, {
        onOpenAck: (ok) => (ok ? handle.sendText("hi-preview") : reject(new Error("open failed"))),
        onText: resolve,
        onBin: () => {},
        onClose: (code, reason) => reject(new Error(`closed ${code} ${reason}`)),
      });
    });
    expect(echoed).toBe("hi-preview");
  });

  test("ws open against a dead upstream acks not-ok or closes", async () => {
    const [hostSide, clientSide] = memoryTransportPair();
    new TunnelHost(hostSide, { port: 1 });
    const client = new TunnelClient(clientSide);
    const result = await new Promise<string>((resolve) => {
      client.openWs("/ws", undefined, {
        onOpenAck: (ok) => resolve(ok ? "open" : "ack-fail"),
        onText: () => {},
        onBin: () => {},
        onClose: () => resolve("closed"),
      });
    });
    expect(["ack-fail", "closed"]).toContain(result);
  });
});

describe("backpressure", () => {
  test("host pauses sends above HIGH_WATER and resumes on drain", async () => {
    const [hostSide, clientSide] = memoryTransportPair();
    new TunnelHost(hostSide, { port: server.port! });
    const client = new TunnelClient(clientSide);

    // Saturate the host's send queue before it can answer.
    hostSide.setFakeBufferedAmount(8 * 1024 * 1024);
    const pending = client.fetch("GET", "/hello?name=bp", {});

    // Paused: nothing may resolve while buffered ≥ HIGH_WATER (poll is 100ms).
    const raced = await Promise.race([pending.then(() => "resolved"), Bun.sleep(60).then(() => "paused")]);
    expect(raced).toBe("paused");

    // Drain: the buffered-amount-low callback releases the sender immediately.
    hostSide.setFakeBufferedAmount(0);
    const res = await pending;
    expect(await res.text()).toContain("hi bp");
  });
});

describe("lane closure", () => {
  test("close before head rejects pending fetches and closes WS handlers", async () => {
    const [hostSide, clientSide] = memoryTransportPair();
    // No host at all: requests park until the transport dies.
    const client = new TunnelClient(clientSide);
    const pending = client.fetch("GET", "/never", {});
    pending.catch(() => {}); // observed again below — avoid unhandled-rejection noise
    const wsClosed = new Promise<[number, string]>((resolve) => {
      client.openWs("/ws", undefined, {
        onOpenAck: () => {},
        onText: () => {},
        onBin: () => {},
        onClose: (code, reason) => resolve([code, reason]),
      });
    });
    hostSide.close();
    await expect(pending).rejects.toThrow("tunnel closed");
    expect(await wsClosed).toEqual([1006, "tunnel closed"]);
  });

  test("close mid-body errors the response stream", async () => {
    const [hostSide, clientSide] = memoryTransportPair();
    let firstChunkSent!: () => void;
    const sent = new Promise<void>((r) => (firstChunkSent = r));
    new TunnelHost(hostSide, {
      port: 1,
      onLocal: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new Uint8Array(64));
                firstChunkSent();
                // never closes — the tunnel dying must error the client body
              },
            }),
          ),
        ),
    });
    const client = new TunnelClient(clientSide);
    const res = await client.fetch("GET", "/stream", {});
    await sent;
    const reader = res.body!.getReader();
    await reader.read(); // first chunk arrives
    clientSide.close();
    await expect(reader.read()).rejects.toThrow("tunnel closed");
  });

  test("bulk lane death fails only bulk-pinned requests", async () => {
    const [hostA, clientA] = memoryTransportPair(); // interactive — no host: WS stays pending
    const [hostB, clientB] = memoryTransportPair(); // bulk — no host: fetch parks
    void hostA;
    void hostB;
    const client = new TunnelClient(clientA, clientB);
    const pending = client.fetch("GET", "/never", {}); // pinned to bulk
    pending.catch(() => {});
    let wsClosed = false;
    client.openWs("/ws", undefined, {
      onOpenAck: () => {},
      onText: () => {},
      onBin: () => {},
      onClose: () => {
        wsClosed = true;
      },
    });
    clientB.close();
    await expect(pending).rejects.toThrow("tunnel closed");
    expect(wsClosed).toBe(false); // interactive lane (and its WS) unaffected
  });
});

describe("bulk lane", () => {
  test("http rides the bulk transport when open", async () => {
    const [hostA, clientA] = memoryTransportPair(); // interactive
    const [hostB, clientB] = memoryTransportPair(); // bulk
    new TunnelHost(hostA, { port: server.port! });
    new TunnelHost(hostB, { port: server.port! });
    const client = new TunnelClient(clientA, clientB);

    let interactiveFrames = 0;
    const origSend = clientA.send.bind(clientA);
    clientA.send = (f) => {
      interactiveFrames++;
      origSend(f);
    };

    const res = await client.fetch("GET", "/hello?name=bulk", {});
    expect(await res.text()).toContain("hi bulk");
    expect(interactiveFrames).toBe(0); // all frames took the bulk lane

    // WS still rides the interactive lane.
    const ok = await new Promise<boolean>((resolve) => {
      client.openWs("/ws", undefined, {
        onOpenAck: resolve,
        onText: () => {},
        onBin: () => {},
        onClose: () => resolve(false),
      });
    });
    expect(ok).toBe(true);
    expect(interactiveFrames).toBeGreaterThan(0);
  });
});
