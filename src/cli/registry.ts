import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// One-daemon-per-host coordination (Phase 5 of the resource-model redesign).
// A single VS Code serve-web opens ANY local path via ?folder=, so one root
// daemon can carry every workspace on the machine: a later `codehost dev`
// REGISTERS its directory here and exits instead of spawning a second peer +
// VS Code. The daemon advertises registered dirs in meta.workspaces and
// re-reads this registry on fs.watch + the slow refresh tick.

export const CODEHOST_DIR = join(homedir(), ".codehost");
const DAEMON_FILE = join(CODEHOST_DIR, "daemon.json");
const WORKSPACES_FILE = join(CODEHOST_DIR, "workspaces.json");

/** Written by a foreground root daemon while it runs; staleness is detected by
 *  pid liveness, so a kill -9 leftover never blocks anything. */
export interface DaemonPresence {
  pid: number;
  /** Real OS path of the served root. */
  root: string;
  /** Room token the daemon registered with — later `dev` runs print a link
   *  into THIS room, since that's where the workspace will appear. */
  token: string;
  startedAt: number;
}

export interface RegisteredWorkspace {
  /** Real OS path. */
  path: string;
  addedAt: number;
}

export function writeDaemonPresence(p: DaemonPresence, file: string = DAEMON_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(p, null, 2));
}

export function clearDaemonPresence(file: string = DAEMON_FILE): void {
  try {
    rmSync(file);
  } catch {
    // already gone
  }
}

/** The live host daemon, or null (no file, unparsable, or its pid is dead). */
export function liveDaemon(file: string = DAEMON_FILE): DaemonPresence | null {
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as DaemonPresence;
    if (typeof p.pid !== "number" || !p.root || !p.token) return null;
    process.kill(p.pid, 0);
    return p;
  } catch {
    return null;
  }
}

/** Add a directory to the host's workspace registry (idempotent). */
export function registerWorkspace(path: string, file: string = WORKSPACES_FILE): void {
  const dir = resolve(path);
  const all = readRegistry(file);
  if (all.some((w) => w.path === dir)) return;
  all.push({ path: dir, addedAt: Date.now() });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
}

/** Registered workspaces whose directories still exist. */
export function readRegisteredWorkspaces(file: string = WORKSPACES_FILE): RegisteredWorkspace[] {
  return readRegistry(file).filter((w) => {
    try {
      return statSync(w.path).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The registry path — daemons fs.watch its directory for instant re-advertise. */
export function workspacesFile(): string {
  return WORKSPACES_FILE;
}

function readRegistry(file: string): RegisteredWorkspace[] {
  try {
    if (!existsSync(file)) return [];
    const arr = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(arr) ? arr.filter((w) => w && typeof w.path === "string") : [];
  } catch {
    return [];
  }
}
