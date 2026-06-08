// Shared helpers for GitHub-shaped deep links and matching them to a daemon.
// Used by the web resolver (src/web) and conceptually mirrors the daemon's
// repo identity (src/cli/git.ts).

import type { PeerInfo, PeerMeta } from "./signaling";

export const DEFAULT_LAYOUT = "{owner}/{repo}/tree/{branch}";

export interface RepoTarget {
  provider: "gh";
  owner: string;
  name: string;
  /** Branch from the deep link, if present. */
  branch?: string;
}

/** A direct folder mount address: `/dev/<absolute-fs-path>`. */
export interface DevTarget {
  path: string;
}

export type DeepLink =
  | { type: "repo"; target: RepoTarget }
  | { type: "dev"; target: DevTarget }
  | null;

/**
 * Parse a deep-link pathname:
 *   /gh/<owner>/<repo>                  -> repo target (default branch)
 *   /gh/<owner>/<repo>/tree/<branch>    -> repo target (branch; may contain slashes)
 *   /dev/<fs-path>                      -> direct folder mount
 * Anything else -> null (normal app).
 */
export function parseDeepLink(pathname: string): DeepLink {
  const clean = pathname.replace(/\/+$/, "");
  const gh = clean.match(/^\/gh\/([^/]+)\/([^/]+)(?:\/tree\/(.+))?$/);
  if (gh) {
    return {
      type: "repo",
      target: { provider: "gh", owner: gh[1], name: gh[2], branch: gh[3] },
    };
  }
  const dev = clean.match(/^\/dev\/(.+)$/);
  if (dev) {
    return { type: "dev", target: { path: `/${dev[1].replace(/^\/+/, "")}` } };
  }
  return null;
}

/** Normalized repo key, e.g. "gh/owner/repo". */
export function repoKey(t: Pick<RepoTarget, "owner" | "name">): string {
  return `gh/${t.owner}/${t.name}`;
}

/**
 * Normalize a served workspace path to the POSIX-drive form the browser side
 * and VS Code web expect. A Windows drive path becomes a `/c/...` style path
 * (lowercased drive, backslashes -> slashes): `C:\ws` -> `/c/ws`,
 * `C:\Users\x` -> `/c/Users/x`, `D:\` -> `/d`. POSIX absolute paths (mac/linux)
 * are returned unchanged. Used for `PeerMeta.cwd`, which feeds the `?folder=`
 * URI — the real OS path is still used for the local VS Code working dir.
 */
export function toPosixPath(p: string): string {
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p);
  if (drive) {
    const letter = drive[1].toLowerCase();
    const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return rest ? `/${letter}/${rest}` : `/${letter}`;
  }
  // Already POSIX (or a relative path): just unify any stray backslashes.
  return p.replace(/\\/g, "/");
}

/** Fill a layout template from a repo target (default branch -> "main"). */
export function fillLayout(layout: string, t: RepoTarget): string {
  return layout
    .replace(/\{owner\}/g, t.owner)
    .replace(/\{repo\}/g, t.name)
    .replace(/\{branch\}/g, t.branch || "main");
}

export interface Resolution {
  peerId: string;
  /** Folder to open via ?folder= (root kind); undefined opens the repo as-is. */
  folder?: string;
}

/**
 * Pick the best live server for a repo deep link. Prefers an exact `repo`
 * daemon; otherwise falls back to a `root` daemon that can open the subfolder.
 * Returns null if nothing matches.
 */
export function resolveRepoTarget(servers: PeerInfo[], target: RepoTarget): Resolution | null {
  const key = repoKey(target);
  const repoMatch = servers.find(
    (s) => s.meta?.kind !== "root" && s.meta?.repo === key && branchOk(s.meta, target),
  );
  if (repoMatch) return { peerId: repoMatch.peerId };

  const root = servers.find((s) => s.meta?.kind === "root");
  if (root && root.meta) {
    const folder = `${trimSlash(root.meta.cwd)}/${fillLayout(root.meta.layout || DEFAULT_LAYOUT, target)}`;
    return { peerId: root.peerId, folder };
  }
  return null;
}

/** Pick a `dev`/repo server whose served cwd matches a /dev/<path> target. */
export function resolveDevTarget(servers: PeerInfo[], target: DevTarget): Resolution | null {
  const want = trimSlash(target.path);
  const hit = servers.find((s) => s.meta && trimSlash(s.meta.cwd) === want);
  return hit ? { peerId: hit.peerId } : null;
}

function branchOk(meta: PeerMeta, target: RepoTarget): boolean {
  // No branch requested, or the server doesn't report one -> accept; else exact.
  if (!target.branch || !meta.branch) return true;
  return meta.branch === target.branch;
}

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}
