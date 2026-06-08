import { spawn, type Subprocess } from "bun";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A minimal, non-oxmgr daemon manager: a detached, self-restarting child that
// survives the shell. Used as a fallback when oxmgr's native binary can't run
// here (e.g. broken on a Windows box) so `-d`/`setup` still leave a running
// server instead of failing or re-download-looping. Tracked in a JSON registry
// so `codehost list`/`stop` can see and manage these alongside oxmgr daemons.
//
// Tradeoff vs oxmgr: no login auto-start (that's oxmgr's per-OS service bit). It
// does survive the launching shell and restarts the server on crash.

const ROOT = join(homedir(), ".codehost");
const REGISTRY = join(ROOT, "daemons.json");
const LOG_DIR = join(ROOT, "logs");

export interface FallbackDaemon {
  name: string;
  /** Supervisor process pid. */
  pid: number;
  cwd: string;
  /** The foreground serve argv the supervisor (re)spawns. */
  argv: string[];
  log: string;
  startedAt: number;
}

function readRegistry(): FallbackDaemon[] {
  try {
    return JSON.parse(readFileSync(REGISTRY, "utf8")) as FallbackDaemon[];
  } catch {
    return [];
  }
}

function writeRegistry(list: FallbackDaemon[]): void {
  mkdirSync(dirname(REGISTRY), { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(list, null, 2));
}

/** True if a pid is currently alive (signal 0 probe). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start (replacing any same-named instance) a detached, self-restarting daemon
 * that runs `argv` from `cwd`, with output appended to a per-daemon log. Returns
 * false if the supervisor couldn't be spawned.
 */
export function startFallbackDaemon(opts: { name: string; argv: string[]; cwd: string }): boolean {
  stopFallbackDaemon(opts.name); // replace any previous instance with this name

  mkdirSync(LOG_DIR, { recursive: true });
  const log = join(LOG_DIR, `${opts.name}.log`);
  const fd = openSync(log, "a");
  const proc = spawn(
    [process.execPath, process.argv[1], "__supervise", "--name", opts.name, "--argv", JSON.stringify(opts.argv)],
    { cwd: opts.cwd, stdin: "ignore", stdout: fd, stderr: fd },
  );
  // Detach so the launching process (setup / serve -d) can exit while this keeps
  // running as an orphan.
  proc.unref();
  if (!proc.pid) return false;

  const list = readRegistry().filter((d) => d.name !== opts.name);
  list.push({ name: opts.name, pid: proc.pid, cwd: opts.cwd, argv: opts.argv, log, startedAt: Date.now() });
  writeRegistry(list);
  return true;
}

/** Live detached daemons (dead registry entries are pruned as a side effect). */
export function listFallbackDaemons(): FallbackDaemon[] {
  const list = readRegistry();
  const alive = list.filter((d) => isAlive(d.pid));
  if (alive.length !== list.length) writeRegistry(alive);
  return alive;
}

/** Stop and deregister a detached daemon by name. Returns false if not found. */
export function stopFallbackDaemon(name: string): boolean {
  const list = readRegistry();
  const hit = list.find((d) => d.name === name);
  if (!hit) return false;
  try {
    process.kill(hit.pid); // SIGTERM -> supervisor kills its child, then exits
  } catch {
    // already gone
  }
  writeRegistry(list.filter((d) => d.name !== name));
  return true;
}

/**
 * Supervisor body (run via the hidden `__supervise` command). Runs the serve
 * argv, restarting it on a non-zero exit with capped exponential backoff; stops
 * when the child exits cleanly or when this process receives SIGTERM/SIGINT
 * (killing the child first). Output goes to the inherited log fd.
 */
export async function runSupervisor(name: string, argv: string[]): Promise<number> {
  let child: Subprocess | null = null;
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    try {
      child?.kill();
    } catch {
      // ignore
    }
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  let attempt = 0;
  while (!stopping) {
    console.log(`[codehost:${name}] starting: ${argv.join(" ")}`);
    child = spawn(argv, { cwd: process.cwd(), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (stopping) break;
    if (code === 0) {
      console.log(`[codehost:${name}] server exited cleanly; supervisor stopping.`);
      break;
    }
    attempt++;
    const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    console.error(
      `[codehost:${name}] server exited with code ${code}; restarting in ${Math.round(waitMs / 1000)}s (attempt ${attempt}).`,
    );
    await Bun.sleep(waitMs);
  }
  return 0;
}
