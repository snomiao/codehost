# VS Code CDN proxy (CORS fix)

Status: implemented. Worker side verified; in-browser leg pending a live check.

## Context

When VS Code runs inside the codehost iframe (origin `https://codehost.dev`, served
over the WebRTC tunnel), its workbench fetches configuration from Microsoft's
product CDN — e.g. `_fetchChatControlData` does:

```
fetch('https://main.vscode-cdn.net/extensions/chat.json')
```

That CDN sends **no `Access-Control-Allow-Origin` header**, so the browser blocks the
cross-origin read:

```
Access to fetch at 'https://main.vscode-cdn.net/extensions/chat.json' from origin
'https://codehost.dev' has been blocked by CORS policy: No 'Access-Control-Allow-Origin'
header is present on the requested resource.
```

Our Service Worker only handled same-origin requests (it early-returned on
cross-origin), so these went straight to the CDN and failed. Chat / built-in-extension
control data never loaded and the console filled with CORS errors.

A Service Worker **alone cannot fix this**: it runs in the browser, bound by the same
CORS rules, and cannot turn a no-CORS cross-origin body into a readable one. The fix
needs a server-side proxy that re-serves the bytes with permissive CORS, plus a small
SW change to route the request there.

## Decision

Reuse the already-deployed **signaling Worker** (`worker/index.ts`, served at
`signal.<page-host>`) as a thin, allow-listed CDN proxy. The Service Worker rewrites
blocked CDN requests to it.

```
VS Code iframe (codehost.dev)                signaling Worker (signal.codehost.dev)
  fetch main.vscode-cdn.net/extensions/chat.json
        │  (cross-origin, CORS-blocked)
        ▼
  Service Worker (sw.ts)
    host ends with .vscode-cdn.net ?  ──rewrite──►  GET /cdn/main.vscode-cdn.net/extensions/chat.json
    cache.match() first, else fetch + cache.put()        │  allow-list check (.vscode-cdn.net)
        ▲                                                 │  fetch upstream (server-side, not CORS-bound)
        └──────────── readable response ◄────────────────┘  + Access-Control-Allow-Origin: *
                                                            + preserve content-type, edge-cache
```

**Self-host constraint (important):** the SW targets the **derived** signaling host
(`signal.<current page host>`), never a hardcoded `signal.codehost.dev`. A self-hoster
who serves the page + Worker on their own domain is automatically proxied by their own
Worker at `signal.<their-domain>/cdn/...`, with no code changes. See
`cdnProxyBase(hostname, protocol)` in `src/web/config.ts`.

## Alternatives considered

- **Cloudflare Pages Function on `codehost.dev`** — same-origin and clean, but adds
  Pages Functions to the currently pure-static build/deploy for no gain over reusing the
  Worker we already run.
- **Daemon proxy over the WebRTC tunnel** — most self-host-robust (the daemon is always
  the user's own machine, works even on networks where the browser can't reach the edge)
  and zero hosted cost. Rejected as the default because it is slower (MS → daemon →
  WebRTC → browser), cannot share a cache across users, adds CDN bytes to the WebRTC
  datachannel, and allow-list changes must ship a new CLI to every user. The Worker wins
  on latency, shared edge caching, and one-deploy allow-list updates. Cost is ~$0:
  Cloudflare bills no egress, and these assets are tiny, public, and cacheable.

If a fully air-gapped / browser-can't-reach-the-edge deployment ever matters, the daemon
proxy is the fallback to revisit.

## Security

- The Worker is the **authoritative allow-list**: only hosts ending in `.vscode-cdn.net`
  are proxied (`CDN_HOST_SUFFIX` in `worker/index.ts`). Anything else → `403`. The
  leading dot prevents look-alikes like `notvscode-cdn.net`.
- **GET/HEAD only** (others → `405`). It forwards a path under the chosen host and never
  follows attacker-controlled hostnames, so it is not an open proxy.
- The SW's suffix check (`isProxiableCdnHost` in `src/web/config.ts`) is only an
  optimization deciding what to rewrite; if it ever drifts from the Worker's list, the
  worst case is a `403` or an unproxied request — the Worker stays the real gate.

## Extending the allow-list

If the workbench starts pulling from another host (e.g. `update.code.visualstudio.com`),
widen the gate in two places and redeploy (one Worker + one Pages deploy — no CLI
change):

- `worker/index.ts` — `CDN_HOST_SUFFIX` (or make it a small list of suffixes).
- `src/web/config.ts` — `VSCODE_CDN_SUFFIX` / `isProxiableCdnHost`.

The extension **marketplace** (install/search) is a separate, larger concern (auth,
large payloads) and is intentionally out of scope here.

## Files

- `worker/index.ts` — `/cdn/<host>/<path>` route + `handleCdnProxy` (allow-list, CORS,
  `caches.default` edge cache, `content-type` passthrough, `cache-control`).
- `src/web/sw.ts` — cross-origin branch → `proxyCdn` (rewrite to the derived `/cdn`
  base, Cache API per-browser caching).
- `src/web/config.ts` — `cdnProxyBase`, `isProxiableCdnHost`, `VSCODE_CDN_SUFFIX`
  (shared host derivation, reused by `getSignalUrl`).

## Verification

- **Worker, direct (done):**
  - `curl -i https://signal.codehost.dev/cdn/main.vscode-cdn.net/extensions/chat.json`
    → `200`, `content-type: application/json`, `access-control-allow-origin: *`,
    `cache-control: public, max-age=3600`, real JSON body.
  - `…/cdn/evil.example.com/x` → `403`; `POST …` → `405`.
- **In-browser (pending live check):** open `codehost.dev` (SW active), then from the
  page `fetch('https://main.vscode-cdn.net/extensions/chat.json')` should resolve `200`
  (served via `signal.<host>/cdn/...`) instead of throwing a CORS error; a second call is
  served from the SW cache. Then load VS Code in the iframe and confirm the `chat.json`
  CORS error is gone from the console.
