import { spawnSync } from "node:child_process";

// Derive a normalized repo identity ("gh/<owner>/<repo>") + branch from a git
// working tree, so a `codehost dev` daemon can be addressed by GitHub-shaped
// deep links. Best-effort: returns undefined fields off git / off GitHub.

export interface RepoIdentity {
  /** Normalized identity, e.g. "gh/snomiao/codehost". */
  repo?: string;
  /** Current branch, e.g. "main". */
  branch?: string;
}

/** True if `dir` is inside a git working tree (has a resolvable .git). */
export function isGitRepo(dir: string): boolean {
  const r = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.trim() === "true";
}

export function repoIdentity(dir: string): RepoIdentity {
  if (!isGitRepo(dir)) return {};
  const remote =
    git(dir, ["remote", "get-url", "origin"]) || git(dir, ["config", "--get", "remote.origin.url"]);
  const branch =
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || git(dir, ["symbolic-ref", "--short", "HEAD"]);
  return {
    repo: parseGitHubRemote(remote),
    branch: branch && branch !== "HEAD" ? branch : undefined,
  };
}

/**
 * Parse a GitHub remote URL into "gh/<owner>/<repo>". Handles:
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 * Returns undefined for non-GitHub or unparseable remotes.
 */
export function parseGitHubRemote(url: string): string | undefined {
  const u = url.trim();
  if (!u) return undefined;
  const m = u.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return undefined;
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return undefined;
  return `gh/${owner}/${repo}`;
}

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}
