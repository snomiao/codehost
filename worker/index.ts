import { validateToken } from "../src/shared/token";
import { Room } from "./room";

export { Room };

interface Env {
  ROOM: DurableObjectNamespace;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// VS Code's product CDN sends no CORS headers, so the workbench's cross-origin
// fetches (e.g. main.vscode-cdn.net/extensions/chat.json) are blocked in our
// iframe. We re-serve allow-listed CDN assets with CORS. This is the
// authoritative gate — only hosts under this suffix may be proxied.
const CDN_HOST_SUFFIX = ".vscode-cdn.net";
const CDN_MAX_AGE = 3600;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // GET /cdn/<host>/<path>  -> proxy an allow-listed VS Code CDN asset, adding
    // CORS so it loads cross-origin inside the iframe.
    const cdn = url.pathname.match(/^\/cdn\/([^/]+)(\/.*)?$/);
    if (cdn) {
      return handleCdnProxy(request, cdn[1], `${cdn[2] ?? "/"}${url.search}`);
    }

    // GET /room/:token  -> WebSocket upgrade routed to the per-token DO.
    const match = url.pathname.match(/^\/room\/([^/]+)\/?$/);
    if (match) {
      const token = decodeURIComponent(match[1]);
      // Authoritative gate: reject weak tokens here so a patched CLI/browser
      // can't open a room with a guessable bearer secret.
      const check = validateToken(token);
      if (!check.ok) {
        return new Response(`weak token: ${check.reason}`, { status: 400, headers: CORS });
      }
      const id = env.ROOM.idFromName(token);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "codehost-signal" }), {
        headers: { "content-type": "application/json", ...CORS },
      });
    }

    return new Response("not found", { status: 404, headers: CORS });
  },
};

/**
 * Proxy a single VS Code CDN asset with permissive CORS, edge-cached. Only
 * hosts under CDN_HOST_SUFFIX are allowed (not an open proxy). GET/HEAD only.
 */
async function handleCdnProxy(request: Request, host: string, pathAndQuery: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: CORS });
  }
  if (!host.endsWith(CDN_HOST_SUFFIX)) {
    return new Response("host not allowed", { status: 403, headers: CORS });
  }

  const upstream = `https://${host}${pathAndQuery}`;
  const cacheKey = new Request(upstream, { method: "GET" });
  const cache = caches.default;

  let res = await cache.match(cacheKey);
  if (!res) {
    const up = await fetch(upstream, { method: "GET", redirect: "follow" });
    const headers = new Headers(CORS);
    const ct = up.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    headers.set("cache-control", `public, max-age=${CDN_MAX_AGE}`);
    res = new Response(up.body, { status: up.status, headers });
    if (up.ok) await cache.put(cacheKey, res.clone());
  }

  // HEAD: same headers, no body.
  if (request.method === "HEAD") {
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}
