# codehost — TODO / future features

Parked ideas, roughly in priority order. The in-flight deep-link feature
(`/gh/<owner>/<repo>/tree/<branch>` + `serve`/`dev` split) is tracked in the active
plan, not here.

## Account login / device auth (Tailscale-style)

Replace/augment bearer tokens with account identity.

- CLI: `codehost serve --login=you@gmail.com` runs a device-authorization flow — prints a
  short code + URL; you approve in `codehost.dev` while signed in (Google via **Firebase
  Auth**) as that account. The daemon then holds a credential proving the same identity.
- Web: sign in with Google (Firebase) on codehost.dev.
- Signaling Worker: on room join, verify a Firebase ID token / signed JWT for the account
  instead of (or alongside) the raw token. Personal room is keyed by account, auto-joined
  by both the daemon and the web client — **no token copy-paste**.
- Benefits over tokens: revocable per device, per-account isolation, no shared secret to
  leak. Like Tailscale authenticating devices.
- Keep **token rooms** too (anonymous quick-share); **login rooms** are the "my own
  devices" path. The two can coexist.
- Open questions: Firebase project + Google OAuth client; how the CLI obtains a credential
  (device-code OAuth vs. a Firebase custom-token minted by the Worker after browser
  approval); revocation UI; mapping account -> room id.

## Port / service forwarding — `[port|service].f.codehost.dev`

Expose a dev server running on the daemon (the tunnel already proxies HTTP to
`127.0.0.1:<x>`).

- Needs wildcard DNS `*.f.codehost.dev`, a tiny bootstrap page + its own per-subdomain
  Service Worker, and a `subdomain -> (room, peer, port)` mapping with token/identity
  scoping.
- **Opt-in** registration from a nav/settings panel — do **not** auto-expose every bound
  port (security footgun).

## Containerized dev environments — `codehost docker up [path]`

Run the workspace inside a container instead of on the host (devcontainer / Codespaces
style).

- `bunx codehost docker up [path]` mounts `path` into a container, sets up VS Code
  `serve-web` + the repo's runtime inside (reuse the self-healing `code`/native installers;
  honor the repo's `.devcontainer/devcontainer.json` when present), and runs the codehost
  daemon in-container.
- Access at `codehost.dev/dev/<token>` (or `/gh/...`) via a generated or passed-in token.
- Lifecycle: `docker up` / `down` / `ps`. Composes with port forwarding above for the
  container's services.
- Wins: isolation for untrusted repos, reproducible runtimes, parallel throwaway envs, no
  host pollution.
- Open questions: base image (preinstalled `code`+bun vs. self-heal on first run), volume
  mount perf, how the container daemon gets the token/identity, resource limits.

## agent-yes web terminal UI (over `codehost expose`)

Make `codehost.dev/vs/<peerId>/` actually usable for an exposed agent-yes, not just the raw API.

- Add an HTML/JS terminal UI served by agent-yes's `ts/serve.ts` at `GET /`: xterm in the
  browser, output via `EventSource('./api/tail/<kw>')` (SSE), input via `POST ./api/send`.
- **Use relative paths** (`./api/...`) so it works under the tunnel's `/vs/<peerId>/` prefix
  (the prefix is stripped for the server, but the page's own URLs must stay relative).
- Reference: **snomiao/wtx** (cloned to lib/wtx) — a Bun PTY WebSocket server with replay
  buffer + xterm client. Note wtx uses **WebSocket**; agent-yes uses **SSE + POST** — reuse
  wtx's xterm/client setup but keep agent-yes's transport (or align them).
- Belongs in the agent-yes repo (it's served by agent-yes), enabled once `codehost expose
  7432` is running.

## Real-time collaboration / presence (multiplayer cursors)

Multiple people open the same workspace (different Chrome profiles / accounts) and see each
other's cursors + selections live.

- `serve-web` is single-session: today multiple viewers get independent workbenches with no
  shared awareness. Needs a layer on top.
- Realistic path: a **presence/awareness protocol** — each viewer broadcasts identity +
  cursor/selection over the room substrate we already have (signaling / data channel),
  rendered as remote-cursor decorations via an injected VS Code extension.
- Full concurrent co-editing (CRDT/OT, à la Yjs) is a much bigger lift; MS **Live Share** is
  the off-the-shelf alternative but brings its own backend/auth.
- Depends on identity (see Account login above) to label who's who.

## Deep-link feature follow-ups (after v1)

- Root daemon **enumerates / existence-checks** the repos under its root (vs. v1's
  optimistic `?folder=`): nicer discovery list + accurate matching.
- **Clone-on-demand:** a root daemon `git clone`s `gh/owner/repo` into the root if absent,
  then opens it (codespaces-like).
- **Live cross-room search:** fan out across all joined rooms for a repo with no history
  (multiple concurrent `SignalingClient`s), instead of v1's history-driven single room.
- **Providers beyond GitHub** (`/gl/...`, self-hosted) via the `provider` field already in
  `parseDeepLink`.
- Reflect the active repo back into the URL while browsing; chooser UI when several
  machines/rooms serve the same repo.
