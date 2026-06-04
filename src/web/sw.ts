/// <reference lib="webworker" />
// Service Worker: intercepts HTTP requests to /vs/<peerId>/* and forwards them
// to the controlling page (which owns the WebRTC data channel) over a
// MessageChannel, streaming the response back. WebSocket connections can't be
// intercepted here, so we inject a bootstrap script into VS Code's HTML that
// overrides window.WebSocket inside the iframe (see tunnel-websocket.ts).
import { cdnProxyBase, isProxiableCdnHost } from "./config";

const sw = self as unknown as ServiceWorkerGlobalScope;

const VS_PREFIX = /^\/vs\/([^/]+)(\/.*)?$/;
const CDN_CACHE = "codehost-cdn-v1";

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) {
    // VS Code's product CDN (main.vscode-cdn.net, ...) sends no CORS headers, so
    // its cross-origin fetches fail in our iframe. Route them through the
    // signaling Worker, which re-serves them with permissive CORS.
    if (event.request.method === "GET" && isProxiableCdnHost(url.hostname)) {
      event.respondWith(proxyCdn(url));
    }
    return; // all other cross-origin requests pass through untouched
  }

  // Serve the iframe bootstrap from the SW itself (same-origin, CSP 'self').
  if (url.pathname === "/__codehost/bootstrap.js") {
    event.respondWith(bootstrapResponse());
    return;
  }

  const m = url.pathname.match(VS_PREFIX);
  if (!m) return; // let the network/Pages handle the discovery app itself
  const peerId = m[1];

  event.respondWith(proxyOverTunnel(event.request, peerId));
});

/**
 * Fetch an allow-listed VS Code CDN asset through the signaling Worker's /cdn
 * route (which adds CORS), caching the result so each asset crosses to the
 * Worker once per browser rather than on every request.
 */
async function proxyCdn(url: URL): Promise<Response> {
  const target = `${cdnProxyBase(sw.location.hostname, sw.location.protocol)}/cdn/${url.hostname}${url.pathname}${url.search}`;
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(target);
  if (hit) return hit;
  try {
    const res = await fetch(target);
    if (res.ok) void cache.put(target, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    return new Response(`cdn proxy error: ${String(err)}`, { status: 502 });
  }
}

async function proxyOverTunnel(request: Request, peerId: string): Promise<Response> {
  const client = await pickClient();
  if (!client) return new Response("no codehost page open", { status: 502 });

  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  // Tell the daemon our public host so VS Code advertises it as the client's
  // remoteAuthority and builds same-origin resource URLs (vscode-remote-resource,
  // extension grammars) that route back through the tunnel — instead of the
  // unreachable 127.0.0.1:<port> it bakes in when it only sees the local host.
  headers["x-forwarded-host"] = sw.location.host;
  const bodyBuf =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());

  const isDocument = request.mode === "navigate" || request.destination === "document";

  return new Promise<Response>((resolve) => {
    const mc = new MessageChannel();
    let resolved = false;

    mc.port1.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "head") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            mc.port1.onmessage = (e2) => {
              const m2 = e2.data;
              if (m2.type === "body") controller.enqueue(new Uint8Array(m2.chunk));
              else if (m2.type === "end") controller.close();
              else if (m2.type === "error") controller.error(new Error(m2.message));
            };
          },
        });

        // Inject the WS-shim bootstrap into VS Code's HTML documents.
        const headers = new Headers(msg.headers);
        const ct = headers.get("content-type") ?? "";
        if (isDocument && ct.includes("text/html")) {
          resolved = true;
          resolve(injectBootstrap(stream, msg, peerId, headers));
          return;
        }
        resolved = true;
        resolve(new Response(stream, { status: msg.status, statusText: msg.statusText, headers }));
      } else if (msg.type === "error" && !resolved) {
        resolved = true;
        resolve(new Response(`tunnel error: ${msg.message}`, { status: 502 }));
      }
    };

    client.postMessage(
      {
        type: "tunnel-fetch",
        peerId,
        method: request.method,
        path: url.pathname + url.search,
        headers,
        body: bodyBuf,
      },
      [mc.port2, ...(bodyBuf ? [bodyBuf.buffer] : [])],
    );
  });
}

// Strip CSP so our injected same-origin bootstrap can run, and prepend the
// bootstrap <script> as the first thing in <head>.
async function injectBootstrap(
  stream: ReadableStream<Uint8Array>,
  head: { status: number; statusText: string },
  peerId: string,
  headers: Headers,
): Promise<Response> {
  const raw = await new Response(stream).text();
  const tag = `<script src="/__codehost/bootstrap.js" data-peer="${peerId}" data-base="/vs/${peerId}"></script>`;
  const html = raw.includes("<head>") ? raw.replace("<head>", `<head>${tag}`) : tag + raw;
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.set("content-length", String(new TextEncoder().encode(html).byteLength));
  return new Response(html, { status: head.status, statusText: head.statusText, headers });
}

async function pickClient(): Promise<Client | null> {
  const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Prefer the top-level discovery page (not the VS Code iframe).
  const top = all.find((c) => !new URL(c.url).pathname.startsWith("/vs/"));
  return top ?? all[0] ?? null;
}

function bootstrapResponse(): Response {
  // Runs inside the VS Code iframe. The parent page exposes its TunnelClient
  // factory at window.parent.__codehostMakeWS (same-origin), which returns a
  // WebSocket-compatible class bound to the right peer + base path.
  const js = `(() => {
    const el = document.currentScript;
    const base = el && el.getAttribute('data-base');
    const peer = el && el.getAttribute('data-peer');
    try {
      const make = window.parent.__codehostMakeWS;
      if (make && base && peer) {
        const Shim = make(peer, base);
        if (Shim) window.WebSocket = Shim;
      }
    } catch (e) { console.error('[codehost] WS shim install failed', e); }
  })();`;
  return new Response(js, {
    headers: { "content-type": "text/javascript", "cache-control": "no-store" },
  });
}
