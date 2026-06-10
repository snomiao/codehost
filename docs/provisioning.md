# Workspace provisioning

Status: **design / proposal** (not implemented). Captures the design discussed
for "open a repo link → the workspace materializes on the host".

## Goal

Opening a repo deep link should *materialize* the workspace on the serving host
on demand — clone / worktree-add / install — instead of requiring it to already
exist. Today, opening `/gh/<owner>/<repo>/tree/<branch>` when that worktree isn't
present just fails (`serve-web` reports "workspace does not exist").

The host owner stays in control: all provisioning is a **user-authored,
idempotent script** on the host. codehost never invents commands.

## Model

`codehost serve` runs in a *home* directory (`$HOME_ROOT`):

```
$HOME_ROOT/
├── .codehost/                  # config dir — edited in VS Code itself
│   ├── config.yaml             # settings (workspace path template, allowlist…)
│   ├── setup.sh / setup.bat    # idempotent provisioning, run on every open
│   └── …                       # any other files the user keeps here
└── ws/                         # default workspaces root (redefinable in config.yaml)
    └── <owner>/<repo>/tree/<branch>/
```

- `.codehost/` is the config folder. `ws/` is where github-shaped paths land.
- Default layout: `ws/{owner}/{repo}/tree/{branch}` (the `tree/<branch>` worktree
  convention — branches are real side-by-side directories).
- The workspace path is redefinable in `config.yaml`.

## Open flow

```
open /gh/<owner>/<repo>/tree/<branch>
  → daemon runs .codehost/setup.sh with owner/repo/branch (+ host)
       setup.sh decides: clone / git worktree add / pull / rebase / skip
       (idempotent — the policy, incl. auto-upgrade/rebase, is the user's)
  → VS Code opens the resulting workspace path
```

Because `setup.sh` is idempotent and runs **every** time, codehost does not track
clone state at all — the script clones if missing, fast-skips if present, and the
user decides whether to auto-pull/rebase. This removes a lot of codehost logic.

## `setup.sh` contract

- **Input** (env, never interpolated into a command string):
  `CODEHOST_OWNER`, `CODEHOST_REPO`, `CODEHOST_BRANCH`, `CODEHOST_HOST`,
  `CODEHOST_HOME` (the home root), `CODEHOST_WS` (the resolved default path from
  the `config.yaml` template).
- **Output**: the absolute workspace path on stdout (last line). If it prints
  nothing, codehost uses `CODEHOST_WS` (the template default).
- **Exit non-zero** → provisioning failed; surface the error to the browser.
- Must be **idempotent** and fast on an already-provisioned path (skip).
- **Windows**: `setup.bat` (or pwsh) with the same env contract.

## `config.yaml` (sketch)

```yaml
workspace: "ws/{owner}/{repo}/tree/{branch}"   # path template, relative to home
allowlist:                                      # which repos may auto-provision
  - github.com/snomiao/*
# …future: default branch, install hook, etc.
```

## Reuse VS Code for config (no custom UI)

Editing config = open `$HOME_ROOT/.codehost/` in the **existing VS Code iframe**.
A "Config" affordance in the header opens `?folder=<home>/.codehost`. No
`/p/<peer-id>/` settings page, no re-invented editor. (Peer ids are ephemeral —
they change on every daemon restart — so config is keyed by the host/home, not
the peer.)

## Create-from-GitHub input box

On the workspace list page, an input: **paste a GitHub URL**.

```
https://github.com/snomiao/codehost/tree/main
  → parse → /gh/snomiao/codehost/tree/main → open (triggers provisioning)
```

One paste opens any GitHub repo on a connected host (= "create workspace from
GitHub"). Accepts bare `github.com/<owner>/<repo>` and `…/tree/<branch>` forms.

## Provisioning UX

- While `setup.sh` runs, show a **"provisioning…"** state with the script's
  stdout/stderr **streamed over the tunnel** (clone/install can take a while).
- Idempotent re-opens skip and are near-instant.

## Security (the crux)

- **Commands are host-authored** (`setup.sh` lives on the host). The link/viewer
  supplies only `owner/repo/branch` identity — never commands.
- codehost **sanitizes** `owner/repo/branch` before handing them to `setup.sh`
  (reject `;`, `$()`, backticks, newlines, `..`, path separators where not
  expected) and passes them as **env**, not string-interpolated into a command.
- **allowlist** (`config.yaml` / `setup.sh`) gates which repos auto-provision;
  others prompt or are denied.
- Any room member can trigger `setup.sh` with any identity, so the **room token
  is the trust boundary** and `setup.sh`/allowlist owns repo policy. Editing
  config (= changing what runs on the host) may warrant owner auth beyond the
  room token — open question.

## Defaults / scaffolding

- No `.codehost/setup.sh` → fall back to today's behavior (resolve to the layout
  path, no clone).
- `codehost init` scaffolds a starter `.codehost/` (`config.yaml` + a `setup.sh`
  that does `gh repo clone` + `git worktree add` + the `ws/` convention).

## Related fix (independent, same path)

`resolveRepoTarget` picks the *first* root daemon without checking which one
actually contains the repo, so with multiple roots it can pick the wrong one
(observed live: it chose `/Users/sno` over the correct `/Users/sno/ws`, yielding
a non-existent subpath). Prefer the **deepest matching root** (longest `cwd`
prefix). Not part of provisioning, but it gates the same "open a repo" path.

## Open questions

1. Source of truth for the path: `setup.sh` stdout vs `config.yaml` template.
   (Proposed: stdout wins; the template is the default handed in as `CODEHOST_WS`.)
2. Owner auth for editing config beyond the room token?
3. Log streaming transport: a new tunnel channel vs reuse of an existing one.
