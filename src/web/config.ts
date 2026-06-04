// Default signaling endpoint. In production the page is served from
// codehost.dev and talks to the Worker on signal.codehost.dev; in local dev
// (vite on :5173) it talks to `wrangler dev` on :8787. Override either with
// localStorage key "codehost.signal".

/** The signaling host for a given page host, e.g. signal.codehost.dev. */
function signalHost(hostname: string): string {
  return `signal.${hostname.replace(/^www\./, "")}`;
}

function defaultSignalUrl(): string {
  // Read location off globalThis so this module also type-checks in the Service
  // Worker build (webworker lib, no `window`). In a worker there's no signaling
  // anyway; getSignalUrl is page-only and tree-shaken out of the SW bundle.
  const loc = (globalThis as { location?: { hostname: string; protocol: string } }).location;
  if (!loc) return "wss://signal.codehost.dev";
  const { hostname, protocol } = loc;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (isLocal) return "ws://localhost:8787";
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${signalHost(hostname)}`;
}

export function getSignalUrl(): string {
  const ls = (globalThis as { localStorage?: { getItem(k: string): string | null } }).localStorage;
  const override = ls?.getItem("codehost.signal");
  if (override) return override;
  return defaultSignalUrl();
}

// --- VS Code CDN proxy ---------------------------------------------------
// Microsoft's VS Code product CDN sends no CORS headers, so the workbench's
// cross-origin fetches (e.g. https://main.vscode-cdn.net/extensions/chat.json)
// are blocked when VS Code runs inside our iframe. The Service Worker rewrites
// those requests to the signaling Worker's /cdn route, which re-serves them
// with Access-Control-Allow-Origin: *. See docs/vscode-cdn-proxy.md.

/** Hostname suffix for the CDN we proxy. The Worker is the authoritative gate;
 *  this lets the SW know which cross-origin requests to rewrite. */
export const VSCODE_CDN_SUFFIX = ".vscode-cdn.net";

export function isProxiableCdnHost(hostname: string): boolean {
  return hostname.endsWith(VSCODE_CDN_SUFFIX);
}

/**
 * HTTPS base of the signaling host for the current page, e.g.
 * https://signal.codehost.dev. The SW rewrites blocked CDN requests to
 * `${base}/cdn/<host>/<path>`. Derived from the live host (never hardcoded) so a
 * self-hoster serving the page + Worker on their own domain is proxied by their
 * own Worker at signal.<their-domain>.
 */
export function cdnProxyBase(hostname: string, protocol: string): string {
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (isLocal) return "http://localhost:8787";
  const httpProto = protocol === "https:" ? "https:" : "http:";
  return `${httpProto}//${signalHost(hostname)}`;
}
