import { afterAll, describe, expect, test } from "bun:test";
import { TunnelClient } from "../../tunnel/client";
import type { TunnelWsHandle, TunnelWsHandlers } from "../../tunnel/client";
import { TunnelHost } from "../../tunnel/host";
import { memoryTransportPair } from "../../tunnel/testing";
import { previewPlugin } from "./preview";
import { routePlugins } from "./types";

// Dev-server compatibility fixtures.
//
// These boot small `Bun.serve` "dev servers" that reproduce the behaviours real
// dev servers (Vite, Next.js, webpack-dev-server, CRA, static hosts) rely on —
// Host allow-lists, absolute-path subresources, HMR WebSockets, SSE, gzip,
// Set-Cookie, redirects — and drive them through the REAL production P2P-preview
// path: a browser's Service Worker sends `/__codehost/port/<PORT>/…` over the
// tunnel, TunnelHost hands `/__codehost/*` to `routePlugins([previewPlugin()])`,
// and the preview plugin proxies to `127.0.0.1:<PORT>`. If a dev server renders
// in the console preview, one of these fixtures should model why.

/** Wire a client to a host whose local routes are the daemon's real plugins. */
function connectPreview() {
  const [hostSide, clientSide] = memoryTransportPair();
  const plugins = [previewPlugin()];
  const host = new TunnelHost(hostSide, {
    // `port` is unused here: every request/WS carries an explicit
    // `/__codehost/port/<PORT>/` prefix that the preview plugin / openWs honour.
    port: 1,
    onLocal: (req) => routePlugins(plugins, req),
  });
  const client = new TunnelClient(clientSide);
  return { host, client };
}

/** The tunnel path a browser SW uses for a proxied dev server on `port`. */
const P = (port: number, rest = "/") => `/__codehost/port/${port}${rest}`;

// The public host the browser presents (an exposure subdomain / the console
// origin). A naive proxy would forward this as-is and trip dev-server allow-lists.
const PUBLIC_HOST = "x7k3m9.agent-yes.com";
const asBrowser = { host: PUBLIC_HOST, "accept-encoding": "gzip, br, deflate" };

// ── Vite-like: Host allow-list + absolute-path subresources + HMR WebSocket ──
const vite = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    // Vite/webpack/Next reject any request whose Host isn't loopback/allow-listed
    // ("Blocked request. This host is not allowed."). The proxy MUST rewrite Host
    // to 127.0.0.1:<port> for the app to answer at all.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return new Response("Blocked request. This host is not allowed.", { status: 403 });
    if (url.pathname === "/@vite/client")
      return new Response("export const hot = {};", {
        headers: { "content-type": "text/javascript" },
      });
    if (url.pathname === "/") {
      // HMR clients connect a WebSocket to the page origin with the `vite-hmr`
      // subprotocol; a plain GET gets the HTML shell.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const proto = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        if (srv.upgrade(req, { headers: proto ? { "sec-websocket-protocol": proto } : {} }))
          return undefined as unknown as Response;
        return new Response("expected ws", { status: 400 });
      }
      return new Response(
        `<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body>vite app</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(ws, msg) {
      ws.send(msg); // echo, standing in for HMR pings
    },
  },
});

// ── Next.js-like: relative + absolute redirects, Set-Cookie, SSE, gzip ───────
const sse = () =>
  new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("event: connected\ndata: ok\n\n"));
      controller.enqueue(enc.encode('data: {"action":"building"}\n\n'));
      controller.enqueue(enc.encode('data: {"action":"built"}\n\n'));
      controller.close();
    },
  });

const next = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/login")
      // Host-relative redirect (the common case) + a session cookie.
      return new Response(null, {
        status: 302,
        headers: { location: "/dashboard", "set-cookie": "sid=abc123; Path=/; HttpOnly" },
      });
    if (url.pathname === "/old")
      // Absolute redirect built from the request Host — after the proxy rewrote
      // Host to loopback this becomes an unreachable `http://127.0.0.1:<port>/…`.
      return new Response(null, {
        status: 308,
        headers: { location: `http://${req.headers.get("host")}/new` },
      });
    if (url.pathname === "/_next/webpack-hmr")
      return new Response(sse(), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    if (url.pathname === "/big.js")
      // A gzip-encoded asset (what dev servers send to a gzip-capable client).
      return new Response(Bun.gzipSync(Buffer.from("//" + "x".repeat(2000))), {
        headers: { "content-encoding": "gzip", "content-type": "text/javascript" },
      });
    return new Response(`next: ${url.pathname}`);
  },
});

// Bun types `.port` as number | undefined; a `port: 0` server always has one.
const VITE = vite.port!;
const NEXT = next.port!;

afterAll(() => {
  vite.stop(true);
  next.stop(true);
});

describe("dev-server compat: HTTP", () => {
  test("Host allow-list: the app answers because Host is rewritten to loopback", async () => {
    const { client } = connectPreview();
    const res = await client.fetch("GET", P(VITE), asBrowser);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("vite app");
  });

  test("absolute-path subresource (/@vite/client) proxies under the port prefix", async () => {
    const { client } = connectPreview();
    const res = await client.fetch("GET", P(VITE, "/@vite/client"), asBrowser);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("hot");
  });

  test("public host reaches the app via x-forwarded-host, Host stays loopback", async () => {
    // A dev server that wants the public origin (canonical URLs) reads it from
    // x-forwarded-host. The tunnel treats a client-sent `x-forwarded-host` as the
    // upstream Host, then the preview plugin overrides Host to loopback and
    // re-exposes the public host in x-forwarded-host — so both are correct.
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        Response.json({ host: req.headers.get("host"), xfh: req.headers.get("x-forwarded-host") }),
    });
    try {
      const { client } = connectPreview();
      const res = await client.fetch("GET", P(probe.port!), {
        ...asBrowser,
        "x-forwarded-host": PUBLIC_HOST,
      });
      const body = (await res.json()) as { host: string; xfh: string };
      expect(body.host).toBe(`127.0.0.1:${probe.port}`);
      expect(body.xfh).toBe(PUBLIC_HOST);
    } finally {
      probe.stop(true);
    }
  });

  test("host-relative redirect + Set-Cookie pass through untouched", async () => {
    const { client } = connectPreview();
    const res = await client.fetch("GET", P(NEXT, "/login"), asBrowser);
    expect(res.status).toBe(302);
    // Relative Location resolves against the preview URL in the browser — good.
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(res.headers.get("set-cookie")).toContain("sid=abc123");
  });

  test("gzip-encoded asset arrives intact (no double-inflate / garbled body)", async () => {
    const { client } = connectPreview();
    const res = await client.fetch("GET", P(NEXT, "/big.js"), asBrowser);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("//" + "x".repeat(2000));
  });

  test("SSE (webpack/Next HMR) streams events incrementally", async () => {
    const { client } = connectPreview();
    const res = await client.fetch("GET", P(NEXT, "/_next/webpack-hmr"), asBrowser);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: connected");
    expect(text).toContain('"action":"building"');
    expect(text).toContain('"action":"built"');
  });

  test("KNOWN LIMITATION: an absolute loopback redirect is passed through verbatim", async () => {
    // A dev server that builds an absolute redirect from the (now-loopback) Host
    // emits `http://127.0.0.1:<port>/…`, which the browser can't reach. The P2P
    // preview plugin can't rewrite it (it doesn't know the embedder's URL prefix).
    // Documented here so a future fix has a red test to flip.
    const { client } = connectPreview();
    const res = await client.fetch("GET", P(NEXT, "/old"), asBrowser);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`http://127.0.0.1:${NEXT}/new`);
  });
});

describe("dev-server compat: WebSocket (HMR)", () => {
  function openWs(client: TunnelClient, path: string, protocols?: string[]) {
    return new Promise<{ handle: TunnelWsHandle; protocol?: string; messages: string[] }>(
      (resolve, reject) => {
        const messages: string[] = [];
        const timer = setTimeout(() => reject(new Error("ws open timed out")), 4000);
        const handlers: TunnelWsHandlers = {
          onOpenAck: (ok, protocol) => {
            clearTimeout(timer);
            if (!ok) return reject(new Error("ws open rejected"));
            resolve({ handle, protocol, messages });
          },
          onText: (t) => messages.push(t),
          onBin: () => {},
          onClose: () => {},
        };
        const handle = client.openWs(path, protocols, handlers);
      },
    );
  }

  test("HMR WebSocket opens to the dev-server port and echoes", async () => {
    const { client } = connectPreview();
    const { handle, protocol, messages } = await openWs(client, P(VITE), ["vite-hmr"]);
    // Subprotocol negotiated end-to-end (Vite requires the `vite-hmr` protocol).
    expect(protocol).toBe("vite-hmr");
    handle.sendText("ping");
    await Bun.sleep(50);
    expect(messages).toContain("ping");
    handle.close();
  });
});
