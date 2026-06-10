import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_HOST, toPosixPath } from "../shared/repo";
import type { WorkspaceInfo } from "../shared/signaling";

// Enumerate the checkouts that exist under a root daemon's home by walking the
// workspace layout template (e.g. "{owner}/{repo}/tree/{branch}") one segment
// at a time: a literal segment must exist, a placeholder segment matches one
// directory level. A leaf only counts as a workspace when it holds a `.git`
// (directory, or file for a worktree). Feeds PeerMeta.workspaces.

/** Cap the advertised list (meta rides the signaling room broadcast). */
const MAX_WORKSPACES = 200;
/** Cap the intermediate walk so a huge home dir can't blow up enumeration. */
const MAX_FRONTIER = 1000;

export function enumerateWorkspaces(rootDir: string, layout: string, host = GITHUB_HOST): WorkspaceInfo[] {
  let frontier = [{ dir: rootDir, vars: {} as Record<string, string> }];
  for (const seg of layout.split("/").filter(Boolean)) {
    const names = [...seg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const next: typeof frontier = [];
    for (const f of frontier) {
      if (next.length >= MAX_FRONTIER) break;
      if (names.length === 0) {
        const dir = join(f.dir, seg);
        if (isDir(dir)) next.push({ dir, vars: f.vars });
        continue;
      }
      const re = segmentPattern(seg);
      for (const name of listDirs(f.dir)) {
        if (next.length >= MAX_FRONTIER) break;
        if (name.startsWith(".")) continue;
        const m = re.exec(name);
        if (!m) continue;
        const vars = { ...f.vars };
        names.forEach((n, i) => (vars[n] = m[i + 1]));
        next.push({ dir: join(f.dir, name), vars });
      }
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }

  const out: WorkspaceInfo[] = [];
  for (const f of frontier) {
    if (out.length >= MAX_WORKSPACES) break;
    if (!existsSync(join(f.dir, ".git"))) continue;
    const { owner, repo, branch } = f.vars;
    out.push({
      path: toPosixPath(f.dir),
      ...(owner && repo ? { repo: `${host}/${owner}/${repo}` } : {}),
      ...(branch ? { branch } : {}),
    });
  }
  return out;
}

/** A layout segment as a matcher: literals exact, `{name}`s capture. */
function segmentPattern(seg: string): RegExp {
  const escaped = seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{\w+\\\}/g, "([^/]+)")}$`);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
