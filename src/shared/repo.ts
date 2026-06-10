// Shared helpers for git-shaped deep links and matching them to a daemon. Used
// by the web resolver (src/web) and conceptually mirrors the daemon's repo
// identity (src/cli/git.ts). Host-agnostic: GitHub gets the short `/gh/...`
// form, any other host uses `/git/<host>/...`.

import type { PeerInfo, PeerMeta } from "./signaling";

export const DEFAULT_LAYOUT = "{owner}/{repo}/tree/{branch}";
export const GITHUB_HOST = "github.com";
/** Branch assumed when a repo link/target carries none — what `fillLayout` opens
 *  and what the address bar shows, so a bare `/gh/<owner>/<repo>` canonicalizes
 *  to `/gh/<owner>/<repo>/tree/<DEFAULT_BRANCH>`. */
export const DEFAULT_BRANCH = "main";

export interface RepoTarget {
  /** Git host, e.g. "github.com" or "gitlab.com". */
  host: string;
  owner: string;
  name: string;
  /** Branch from the deep link, if present. */
  branch?: string;
}

/** A direct folder mount address: host-scoped `/host/<hostname>/<path>`, or the
 *  legacy host-agnostic `/dev/<path>` (a bare path collides across machines, so
 *  new links carry the host). */
export interface DevTarget {
  /** Hostname the workspace lives on; undefined for a legacy host-agnostic link. */
  host?: string;
  path: string;
}

export type DeepLink =
  | { type: "repo"; target: RepoTarget }
  | { type: "dev"; target: DevTarget }
  | null;

/**
 * Parse a deep-link pathname:
 *   /gh/<owner>/<repo>(/tree/<branch>)            -> GitHub repo target
 *   /git/<host>/<owner>/<repo>(/tree/<branch>)    -> any-host repo target
 *   /host/<hostname>/<fs-path>                    -> host-scoped folder mount
 *   /dev/<fs-path>                                -> legacy host-agnostic folder mount
 * Branch may contain slashes. Anything else -> null (normal app).
 */
export function parseDeepLink(pathname: string): DeepLink {
  const clean = pathname.replace(/\/+$/, "");
  const gh = clean.match(/^\/gh\/([^/]+)\/([^/]+)(?:\/tree\/(.+))?$/);
  if (gh) {
    return {
      type: "repo",
      target: { host: GITHUB_HOST, owner: gh[1], name: gh[2], branch: gh[3] },
    };
  }
  const git = clean.match(/^\/git\/([^/]+)\/([^/]+)\/([^/]+)(?:\/tree\/(.+))?$/);
  if (git) {
    return {
      type: "repo",
      target: { host: git[1].toLowerCase(), owner: git[2], name: git[3], branch: git[4] },
    };
  }
  // Host-scoped folder mount: first segment is the hostname, the rest is the
  // served path (which itself may contain slashes and a Windows drive colon).
  const host = clean.match(/^\/host\/([^/]+)\/(.+)$/);
  if (host) {
    return { type: "dev", target: { host: host[1], path: `/${host[2].replace(/^\/+/, "")}` } };
  }
  // Legacy host-agnostic folder mount.
  const dev = clean.match(/^\/dev\/(.+)$/);
  if (dev) {
    return { type: "dev", target: { path: `/${dev[1].replace(/^\/+/, "")}` } };
  }
  return null;
}

/** Normalized repo key, e.g. "github.com/owner/repo" — matches PeerMeta.repo. */
export function repoKey(t: Pick<RepoTarget, "host" | "owner" | "name">): string {
  return `${t.host}/${t.owner}/${t.name}`;
}

/**
 * Normalize a served workspace path to the form VS Code web's `?folder=` query
 * expects. On Windows that's the file-URI authority form: a leading slash, the
 * drive letter and colon preserved, backslashes -> slashes —
 * `C:\ws` -> `/C:/ws`, `C:\Users\x` -> `/C:/Users/x`, `D:\` -> `/D:`. (The
 * git-bash `/c/ws` form does NOT resolve — serve-web reports "workspace does not
 * exist".) POSIX absolute paths (mac/linux) are returned unchanged, and the
 * result is idempotent. Used for `PeerMeta.cwd`, which feeds the `?folder=` URI
 * (URL-encoded in transit, decoded back to this by VS Code) and the `/dev/<path>`
 * deep link — the real OS path is still used for the local VS Code working dir.
 */
export function toPosixPath(p: string): string {
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p);
  if (drive) {
    const letter = drive[1]; // preserve drive-letter case
    const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return rest ? `/${letter}:/${rest}` : `/${letter}:`;
  }
  // Already POSIX (or a relative path): just unify any stray backslashes.
  return p.replace(/\\/g, "/");
}

/** Fill a layout template from a repo target (default branch -> DEFAULT_BRANCH). */
export function fillLayout(layout: string, t: RepoTarget): string {
  return layout
    .replace(/\{owner\}/g, t.owner)
    .replace(/\{repo\}/g, t.name)
    .replace(/\{branch\}/g, t.branch || DEFAULT_BRANCH);
}

/**
 * Shareable deep-link pathname for a connected workspace. A git-identified
 * server renders `/gh/<owner>/<repo>` for GitHub or `/git/<host>/<owner>/<repo>`
 * for any other host (with `/tree/<branch>` when known); a non-git workspace is
 * addressed by its opened folder, scoped to its hostname as `/host/<host>/<path>`
 * (or the legacy `/dev/<path>` when no host is known). Round-trips through
 * parseDeepLink + resolve{Repo,Dev}Target so another room member opening it
 * lands here. Returns null when there's nothing addressable.
 */
export function shareableDeepLink(opts: {
  repo?: string;
  branch?: string;
  folder?: string;
  host?: string;
}): string | null {
  if (opts.repo) {
    const [host, owner, name] = opts.repo.split("/");
    if (host && owner && name) {
      const base = host === GITHUB_HOST ? `/gh/${owner}/${name}` : `/git/${host}/${owner}/${name}`;
      return opts.branch ? `${base}/tree/${opts.branch}` : base;
    }
  }
  if (opts.folder) {
    const path = opts.folder.replace(/^\/+/, "");
    return opts.host ? `/host/${opts.host}/${path}` : `/dev/${path}`;
  }
  return null;
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

/** Pick a folder-mount server whose served cwd matches the target path, scoped
 *  to `target.host` when the link carries one (a bare path is ambiguous across
 *  machines). Compares with leading + trailing slashes stripped: `parseDeepLink`
 *  forces a leading "/" on the path, but a served cwd may lack one (e.g. an
 *  `expose` server's `localhost:<port>`), so a trailing-only trim never matches. */
export function resolveDevTarget(servers: PeerInfo[], target: DevTarget): Resolution | null {
  const want = stripEnds(target.path);
  const hit = servers.find(
    (s) => s.meta && stripEnds(s.meta.cwd) === want && (!target.host || s.meta.host === target.host),
  );
  return hit ? { peerId: hit.peerId } : null;
}

/** A candidate room (its token) plus how the deep link resolved within it. */
export interface RoomMatch {
  token: string;
  resolution: Resolution;
}

/**
 * Rank matches found while searching multiple rooms for a token-less deep link.
 * An *exact* match (a server that genuinely serves this repo/folder — no
 * synthesized `folder`) beats a *root fallback* (a root daemon that would open
 * the repo as a subfolder, which `resolveRepoTarget` returns for ANY repo link).
 * Without this preference, first-responder-wins could pick an unrelated room
 * that merely has a root server. Returns null when there are no matches.
 */
export function pickRoomMatch(matches: RoomMatch[]): RoomMatch | null {
  return matches.find((m) => !m.resolution.folder) ?? matches[0] ?? null;
}

function branchOk(meta: PeerMeta, target: RepoTarget): boolean {
  // No branch requested, or the server doesn't report one -> accept; else exact.
  if (!target.branch || !meta.branch) return true;
  return meta.branch === target.branch;
}

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Strip leading and trailing slashes — for comparing a `/dev/<path>` target to
 *  a served cwd that may or may not carry a leading slash. */
function stripEnds(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}
