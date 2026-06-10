// Pure provisioning helpers: the security boundary for "open a repo link runs a
// host setup script". The room token already grants code execution (the editor
// is a terminal), so script execution is not new trust — the only new surface is
// a crafted/shared link auto-triggering setup.sh with attacker-chosen
// owner/repo/branch. That surface is bounded entirely here: validate the
// identity so it can't traverse out of the home root or inject options, and
// compute the workspace path **daemon-authoritatively** (never from script
// output). Kept pure + unit-tested precisely because it's the injection gate.

import { DEFAULT_BRANCH, DEFAULT_LAYOUT } from "./repo";

export interface ProvisionTarget {
  owner: string;
  repo: string;
  branch: string;
}

export type ValidateResult = { ok: true; target: ProvisionTarget } | { ok: false; reason: string };

// First char must be alphanumeric: rejects "..", ".", leading-dot tricks, and a
// leading "-" in one stroke (a bare `[A-Za-z0-9._-]+` would match "..").
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Positive allowlist for a branch ref as a whole: safe path chars only. Excludes
// whitespace, control chars, and shell metacharacters by construction.
const BRANCH_CHARS = /^[A-Za-z0-9._/-]+$/;

/** Validate the (owner, repo, branch) identity carried by a repo deep link before
 *  it is used to build a filesystem path or passed to a setup script. Branch may
 *  contain "/" (worktree refs) but no empty/`.`/`..` segment and no segment
 *  starting with "-" (else `git checkout "$BRANCH"` eats it as an option flag —
 *  option injection survives env-passing because the script interpolates it). An
 *  empty branch defaults to DEFAULT_BRANCH. */
export function validateProvisionTarget(owner: string, repo: string, branch: string): ValidateResult {
  if (!SEGMENT.test(owner)) return { ok: false, reason: `invalid owner: ${owner}` };
  if (!SEGMENT.test(repo)) return { ok: false, reason: `invalid repo: ${repo}` };
  const b = (branch || DEFAULT_BRANCH).trim();
  if (!BRANCH_CHARS.test(b)) return { ok: false, reason: `invalid branch: ${b}` };
  const segs = b.split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith("-"))) {
    return { ok: false, reason: `invalid branch: ${b}` };
  }
  return { ok: true, target: { owner, repo, branch: b } };
}

/** Fill a workspace layout template from a *validated* target. POSIX-space (the
 *  served cwd is already `toPosixPath`'d), so the result is the `?folder=` form.
 *  Safe against traversal only because `target` passed validateProvisionTarget. */
export function resolveWorkspacePath(homePosix: string, layout: string, target: ProvisionTarget): string {
  const rel = (layout || DEFAULT_LAYOUT)
    .replace(/\{owner\}/g, target.owner)
    .replace(/\{repo\}/g, target.repo)
    .replace(/\{branch\}/g, target.branch);
  return `${homePosix.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/** Whether a repo may be auto-provisioned. An empty/absent allowlist allows all
 *  (provisioning is already opt-in by the presence of setup.sh); otherwise the
 *  repo key `<host>/<owner>/<repo>` must match an entry, where a trailing `/*`
 *  is an owner/prefix wildcard (e.g. `github.com/snomiao/*`). */
export function repoAllowed(repoKey: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.some((rule) => {
    const r = rule.trim();
    if (r.endsWith("/*")) return repoKey.startsWith(r.slice(0, -1));
    return repoKey === r;
  });
}
