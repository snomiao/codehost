# codehost — repo-scoped agent notes

WebRTC-tunneled VS Code: a CLI daemon (`codehost serve`/`dev`) serves a machine; the
codehost.dev page (Cloudflare Pages) connects over a WebRTC data channel; a Worker + Durable
Object (signal.codehost.dev) only relays signaling. See README.md for the architecture.

## Build / typecheck / test / deploy

- **Typecheck:** `bun run typecheck` — three tsconfigs (root, `src/web/tsconfig.sw.json`,
  `worker/tsconfig.json`). All three must pass.
- **Build:** `bun run build` (vite app + service worker) and `bun run build:lib` (the standalone
  `room-client` bundle for embedding).
- **Tests:** `bun test` globs into the **gitignored `tmp/` scratch checkout** (a second project
  missing test deps) and reports false failures. Run project tests only:
  `bun test $(git ls-files '*.test.ts' '*.test.tsx')`.
- **Deploy:** `bun run deploy:signal` (the Worker/DO — only needed when the signaling protocol
  changes) and `bun run deploy:pages` (the codehost.dev site). Wrangler reads
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from `.env.local` (gitignored). The token is
  **account-owned**, so verify it via `/accounts/<id>/tokens/verify`, not `/user/tokens/verify`;
  it has no Zone/DNS scope.
- A push to `main` triggers a semantic-release version bump + npm publish — keep `main` green.

## The signaling protocol is shared AND has live peers in the field

`src/shared/signaling.ts` is the wire contract for the page, the daemon, AND the Worker. Deployed
daemons run many npm versions, so **only make additive/optional changes** to the protocol.

The connecting role is `"client"`, but `"viewer"` remains a valid wire value: receivers accept
either via `isClientRole`, and new code still EMITS `CLIENT_WIRE_ROLE` (currently `"viewer"`)
during an "accept both, emit old" transition — so old and new daemons/pages interoperate. Don't
rename or repurpose wire values, or flip the emitted role, without keeping that compatibility.

## Verifying codehost.dev visually (rech)

To screenshot/verify the live site, drive a real Chrome with `rech` (the `rechrome` package — see
its own CLAUDE.md for setup and the session/scroll caveats). codehost.dev quirks:

- The page scrolls an **inner `<main>` (overflow:auto)**, not the document — so
  `screenshot --full-page` only captures the viewport. To capture below the fold, `resize` the
  window tall enough that everything lays out without inner-scroll, then screenshot and crop.
- The mobile layout kicks in under a **560px** width breakpoint — `resize` to a phone width to
  check it.
- After a Pages deploy, open with a `?cb=<ts>` cache-buster to dodge a stale cached bundle.
