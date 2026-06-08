import { spawnSync } from "node:child_process";

// Derive a normalized, host-agnostic repo identity ("<host>/<owner>/<repo>") +
// branch from a git working tree, so a `codehost dev` daemon can be addressed by
// deep links (/gh/<owner>/<repo> for GitHub, /git/<host>/<owner>/<repo> for any
// other host). Best-effort: returns undefined fields off git / off a recognized
// remote.

export interface RepoIdentity {
  /** Normalized identity, e.g. "github.com/snomiao/codehost". */
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
    repo: parseGitRemote(remote),
    branch: branch && branch !== "HEAD" ? branch : undefined,
  };
}

/**
 * Parse any git remote URL into a host-agnostic "<host>/<owner>/<repo>" key
 * (lowercased host, no trailing `.git`). Handles:
 *   https://github.com/owner/repo(.git)
 *   git@gitlab.com:owner/repo(.git)            (scp-like)
 *   ssh://git@git.company.com:2222/owner/repo  (with optional user/port)
 *   git://host/owner/repo
 * Returns undefined for unparseable remotes. Only the first two path segments
 * (owner/repo) are used; deeper paths (e.g. GitLab subgroups) collapse to those.
 */
export function parseGitRemote(url: string): string | undefined {
  let u = url.trim();
  if (!u) return undefined;
  u = u.replace(/\.git\/?$/i, "");

  let host: string | undefined;
  let path: string | undefined;

  // scp-like syntax: [user@]host:owner/repo (no scheme).
  const scp = u.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  // URL syntax: scheme://[user@]host[:port]/owner/repo
  const uri = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (uri) {
    host = uri[1];
    path = uri[2];
  } else if (scp && !u.includes("://")) {
    host = scp[1];
    path = scp[2];
  }
  if (!host || !path) return undefined;

  const segs = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  return `${host.toLowerCase()}/${segs[0]}/${segs[1]}`;
}

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}
