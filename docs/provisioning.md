# Workspace provisioning

Status: **implemented** — `codehost/provision` is the standard. The contract,
the `~/ws/<owner>/<repo>/tree/<branch>` layout, the clone/fetch/ff-pull state
machine, and the security rules all live in **`src/provision/`** and are
exported for any consumer (the daemon, and external tools that spawn agents
into freshly-provisioned worktrees).

```jsonc
// package.json
"exports": {
  "./provision": "./src/provision/index.ts",        // the core (node builtins + git/bun only)
  "./provision/watch": "./src/provision/watch.ts"    // live status (native @parcel/watcher)
}
```

```ts
import { provision, parseSource } from "codehost/provision";

const spec = parseSource("https://github.com/snomiao/codehost/tree/main");
if (spec) {
  const r = await provision(spec); // r.folder is the VS Code ?folder= target
}
```

The **core** (`src/provision/index.ts`) imports only node builtins and shells
out to `git`/`bun`. It deliberately pulls in **none** of codehost's native
transport (`node-datachannel`), terminal (`bun-pty`), or UI (`react`, `hono`,
`vite`) deps, so an agent spawner can depend on it cheaply. The live filesystem
watcher needs the native `@parcel/watcher`, so it is split into
`src/provision/watch.ts` (`codehost/provision/watch`) — import it only when you
want a live status feed.

## Layout

```
~/ws/<owner>/<repo>/tree/<branch>/
```

`provision`/`createBranch` make each branch an **independent clone** into its own
`tree/<branch>` directory, so branches are real side-by-side checkouts.
(`forkWorktree` is the exception: a shared-object-store `git worktree add` off an
existing checkout's HEAD — see the API below.)

The workspace root is **resolved at call time** by `resolveWsRoot(wsRoot?)`,
precedence:

1. an explicit argument — `provision(spec, { wsRoot })`, `createBranch(spec,
   { wsRoot })`, `folderFor(spec, wsRoot)`, `statusOf(spec, wsRoot)`,
   `watchStatus(spec, onChange, wsRoot)`;
2. `process.env.CODEHOST_WS_ROOT`;
3. `~/ws` (`WS_ROOT`, the default).

All overrides are backward-compatible (omit them for `~/ws`). This lets a
consumer point provisioning at a different layout — e.g. a machine that keeps
repos under `/code/<owner>/<repo>/tree/<branch>` sets `CODEHOST_WS_ROOT=/code`
or passes `{ wsRoot: "/code" }`.

## API (`src/provision/index.ts`)

- `parseSource(input): RepoSpec | null` — normalize any common reference into a
  `RepoSpec`. Accepts `https://github.com/<o>/<r>/tree/<b>`,
  `github.com/<o>/<r>/tree/<b>`, `<o>/<r>/tree/<b>`, `<o>/<r>@<branch>`, and bare
  `<o>/<r>` (defaults branch `main`). Strips a trailing `.git` and `#`/`?` tails.
  The branch may contain `/`.
- `parseSpec(path): RepoSpec | null` — the canonical `<o>/<r>/tree/<b>` parser.
- `folderFor(spec): string` — the absolute worktree path.
- `statusOf(spec): Promise<GitStatus | null>` — git status, or null if the
  worktree isn't provisioned.
- `provision(spec): Promise<ProvisionResult>` — ensure the worktree exists and is
  fresh. Never throws.
- `createBranch(spec): Promise<ProvisionResult>` — clone the default branch and
  `git switch -c <branch>` for a branch that doesn't exist on the remote yet.
- `forkWorktree({ fromCwd, branch, wsRoot?, wip? }): Promise<ProvisionResult>` —
  fork an existing worktree to a NEW branch in a sibling worktree off its current
  HEAD. `git worktree add -b <branch>` off `fromCwd`'s current HEAD (shared object
  store, **no clone**). By default the fork is **clean** — only committed work
  crosses over, so the source's uncommitted changes stay put. Pass `wip: true` to
  also carry the source's uncommitted work: replay tracked changes (`git stash
  create`→`stash apply`, leaving the source worktree untouched) and copy untracked,
  non-ignored files — conflict-free since the new worktree starts at the same HEAD.
  owner/repo come from `fromCwd`'s `origin` remote. `action: "forked"`. Distinct
  from `createBranch` (off the remote default).
- `readStatus(dir)` — low-level porcelain reader (used by `watch`).
- Types: `RepoSpec`, `GitStatus`, `ProvisionResult`, `FailReason`.

## State machine (`provision`)

- **missing** → `git clone --branch <b> --single-branch --recurse-submodules`
  into the worktree path.
- **present** → return the current local status immediately, then in the
  **background** `git fetch --prune` and `git pull --ff-only` **only if** the
  worktree is clean, behind, not ahead, and has an upstream (never clobber local
  work; a slow fetch never blocks the editor opening).
- After a clone, branch creation, or a pull that **advanced** the checkout, run
  the setup script. For a non-`main` branch, seed `.env.local` (seed-once) from
  the sibling `tree/main` worktree.

## `setup-repo.sh`

`src/provision/setup-repo.sh` ships as the **default** setup script and runs via
Bun Shell (`bun setup-repo.sh`, cross-platform). It updates submodules and
installs dependencies for whichever ecosystem(s) the repo uses (JS via its pinned
lockfile, Rust, Go, Python, Ruby). Every step is `|| true` (fail-soft): a missing
toolchain or one ecosystem's hiccup never aborts provisioning.

**Future work:** a user-authored `.codehost/setup.sh` hook in the repo (or home)
may override the default, so the host owner can define their own provisioning
policy. The default ships so provisioning works out of the box.

## Security

- All git runs via `execFile` (argv array, **no shell**) — no command injection.
- Every path segment (`owner`/`repo`/each `branch` part) is validated by
  `isSafeSegment`: non-empty, not `.`/`..`, no leading `-` (option injection), no
  path separators or control chars. A hostile input can't traverse or escape
  `~/ws`. `parseSource` reuses this via `parseSpec`.
- git error messages are forced to `LC_ALL=C` so `branch-not-found` /
  `repo-not-found` classification is locale-stable.
