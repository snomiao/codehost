# codehost

Run VS Code on any machine and reach it from **codehost.dev** over a direct
peer-to-peer **WebRTC** connection — no public ingress, no reverse proxy, no
port forwarding. The daemon behind your NAT and the browser tab connect
directly; a tiny Cloudflare Worker only brokers the handshake.

```
 Browser (codehost.dev)                          Your machine (codehost serve)
 ┌──────────────────────────┐                    ┌──────────────────────────────┐
 │ Discovery: list servers   │                    │ codehost CLI (yargs)          │
 │ Service Worker: /vs/<id>/* │   WebRTC           │ node-datachannel peer         │
 │ ─────────────────────────▶│◀═ data channel ══▶│ HTTP/WS proxy → code serve-web │
 │ <iframe> VS Code           │                    │ in your project directory      │
 └────────────┬─────────────┘                    └───────────────┬──────────────┘y -c
              │ WebSocket (signaling)                             │ WebSocket (signaling)
              └───────────────────► Cloudflare Worker + DO ◄──────┘
                       per-token room: registry + SDP/ICE relay
```

## Quickstart

On the machine you want to edit (needs the `code` CLI and [Bun](https://bun.sh)):

```bash
bunx codehost serve -d -t <token>
```

Then open **https://codehost.dev**, enter the same `<token>`, and your server
appears in the list. Click **Connect** — VS Code loads in the page, served
entirely over the peer-to-peer data channel.

The `<token>` is a shared secret: anyone with it can see and connect to the
servers in that room, so treat it like a password. It must be **at least 12
characters, contain no whitespace, and mix at least 3 of {lowercase, uppercase,
digits, symbols}** — the CLI, the web page, and the signaling Worker all reject
weaker tokens (e.g. `Str0ng-Token-99`).

## CLI

```bash
codehost serve [dir] -t <token> [options]   # serve a directory (default: cwd)
codehost list                                # list daemonized servers (oxmgr)
codehost stop <name>                         # stop a daemonized server
codehost update                              # fetch the latest VS Code CLI now
```

**VS Code is auto-installed.** On first `serve`, codehost uses a `code` already
on your `PATH` if present; otherwise it downloads Microsoft's standalone VS Code
CLI for your OS/arch (verifying its sha256), caches it under `~/.codehost/vscode/`,
and re-checks the stable channel at most once per day. Force a refresh with
`codehost update`, or point at a specific binary with the `CODEHOST_CODE_BIN`
environment variable.

`serve` options:

| flag | default | meaning |
|------|---------|---------|
| `-t, --token` | (required) | room token shared with the codehost.dev page |
| `-d, --daemon` | `false` | run in the background under [oxmgr](https://www.npmjs.com/package/oxmgr) (auto-restart) |
| `--name` | hostname | display name shown on the page |
| `--signal` | `wss://signal.codehost.dev` | signaling server URL |
| `--port` | ephemeral | fixed port for the local `code serve-web` |

Daemon mode requires `oxmgr` (`npm i -g oxmgr`). Without `-d`, `serve` runs in
the foreground and stops on Ctrl-C.

## How it works

1. **Signaling** — `worker/` is a Cloudflare Worker whose Durable Object hosts
   one room per token. Daemons register their metadata; the page lists the
   room's servers; the DO relays WebRTC offer/answer/ICE between them. STUN-only
   (no TURN yet), so strict/symmetric NATs may not connect.
2. **WebRTC** — the daemon uses `node-datachannel` (native, loaded via
   `createRequire` so it resolves under Bun); the browser uses the standard
   `RTCPeerConnection`. The browser is the offerer.
3. **Tunnel** — `code serve-web` runs on `127.0.0.1` under base path
   `/vs/<peerId>`. The browser Service Worker intercepts `/vs/<peerId>/*` and
   forwards each HTTP request to the page, which ships it over the data channel;
   the daemon (`src/cli/tunnel.ts`) replays it against the local VS Code server
   and streams the response back. VS Code's WebSockets are routed the same way
   via an injected `window.WebSocket` shim inside the iframe.

## Development

```bash
bun install
bun run dev          # web terminal scaffold (legacy) on :5173 + :3001
bun run dev:signal   # signaling Worker locally (wrangler dev on :8787)
bun run cli -- serve . -t test --signal ws://localhost:8787   # run the daemon
bun run typecheck    # app + service worker + worker programs
bun run build        # builds dist/public (app + /sw.js)
```

In local dev the page (on `localhost`) auto-targets `ws://localhost:8787`;
override the signaling URL anytime via `localStorage["codehost.signal"]`.

## Deploy

```bash
bun run deploy:signal   # cd worker && wrangler deploy   (Durable Object signaling)
bun run deploy:pages    # vite build && wrangler pages deploy dist/public --project-name codehost
```

The signaling Worker is bound to a `signal.` subdomain of the zone; the page is
the `codehost` Pages project on the `codehost.dev` custom domain (Cloudflare
account `SNOLAB`). After deploying the Worker the first time, add its
`signal.codehost.dev` custom-domain route (commented in `worker/wrangler.jsonc`).

## Status / limitations

- Verified live end-to-end across two networks: a daemon behind one NAT and a
  browser on `codehost.dev` (another network) connect over STUN, the VS Code
  workbench loads in the iframe, the Explorer lists the real workspace, and
  files open in the editor — all HTTP + WebSocket traffic over the data channel.
- Data-channel frames are capped at 16 KiB (the portable WebRTC limit); HTTP
  bodies and WebSocket messages larger than that are fragmented and reassembled
  (`src/shared/protocol.ts`).
- STUN-only: add Cloudflare Realtime TURN for strict/symmetric-NAT reachability.
- Token = bearer auth for now; no per-user identity yet.
