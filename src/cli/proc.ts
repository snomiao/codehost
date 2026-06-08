import { spawnSync } from "node:child_process";

/**
 * Kill a process and all of its descendants. VS Code's `serve-web` launcher
 * double-forks (code -> code-tunnel -> code-server -> node server-main.js), so
 * killing only the spawned launcher leaves the real server running as orphans.
 * Killing the whole tree avoids that leak. Best-effort and synchronous so it can
 * run inside a shutdown handler right before the process exits.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid || pid <= 1) return;
  if (process.platform === "win32") {
    // /T kills the process and its child tree; /F forces it.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // POSIX: signal descendants (leaves first) then the root itself.
  for (const p of [...descendants(pid), pid]) {
    try {
      process.kill(p, signal);
    } catch {
      // already gone
    }
  }
}

/** PIDs descended from `root`, deepest first (so they can be signalled before
 *  their parents). Uses `ps`; returns [] if it's unavailable. */
function descendants(root: number): number[] {
  let out = "";
  try {
    out = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const arr = childrenOf.get(ppid);
    if (arr) arr.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  const result: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of childrenOf.get(p) ?? []) {
      result.push(c);
      stack.push(c);
    }
  }
  return result.reverse();
}
