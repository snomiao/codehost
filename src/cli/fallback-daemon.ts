import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { killProcessTree } from "./proc";
import { pm2Available, pm2Delete, pm2Online, pm2Start } from "@snomiao/daemon-kit";

// A non-oxmgr daemon manager: keeps a server running across the shell without
// depending on oxmgr's flaky native binary. Backends, by platform:
//   - Windows: pm2 (preferred) — restart-on-failure + logon resurrect, launched
//     hidden so no console window appears (see pm2.ts). If pm2 isn't installed we
//     fall back to a Scheduled Task (`schtasks`), which is always available and
//     also auto-starts at logon. Unref'd children don't survive their launcher on
//     Windows, so one of these managers is required.
//   - POSIX: a detached, unref'd supervisor child (reparents to init), running the
//     `__supervise` restart loop and reading its serve argv from this registry.

const ROOT = join(homedir(), ".codehost");
const REGISTRY = join(ROOT, "daemons.json");
const LOG_DIR = join(ROOT, "logs");
const TASK_DIR = join(ROOT, "tasks");
const isWindows = process.platform === "win32";

export interface FallbackDaemon {
  name: string;
  cwd: string;
  /** The foreground serve argv the supervisor (re)spawns. */
  argv: string[];
  log: string;
  startedAt: number;
  /** POSIX: supervisor process pid. */
  pid?: number;
  /** Windows (pm2 backend): pm2 process name (equals `name`). */
  pm2?: string;
  /** Windows (schtasks backend): scheduled-task name (equals `name`). */
  task?: string;
  /** Pid of the serve child the supervisor last spawned (for tree-kill on stop). */
  servePid?: number;
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

function upsert(entry: FallbackDaemon): void {
  writeRegistry([...readRegistry().filter((d) => d.name !== entry.name), entry]);
}

function patch(name: string, fields: Partial<FallbackDaemon>): void {
  const list = readRegistry();
  const hit = list.find((d) => d.name === name);
  if (!hit) return;
  Object.assign(hit, fields);
  writeRegistry(list);
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

function schtasks(args: string[]): number {
  return spawnSync("schtasks", args, { stdio: "ignore" }).status ?? 1;
}

/** True if a Windows scheduled task with this name is registered. */
function taskExists(name: string): boolean {
  return spawnSync("schtasks", ["/query", "/tn", name], { stdio: "ignore" }).status === 0;
}

/**
 * Start (replacing any same-named instance) a daemon that runs `argv` from
 * `cwd`. Returns false if it couldn't be started. The registry entry is written
 * first so the supervisor can read its argv by name.
 */
export function startFallbackDaemon(opts: { name: string; argv: string[]; cwd: string }): boolean {
  stopFallbackDaemon(opts.name); // replace any previous instance

  mkdirSync(LOG_DIR, { recursive: true });
  const log = join(LOG_DIR, `${opts.name}.log`);
  upsert({ name: opts.name, cwd: opts.cwd, argv: opts.argv, log, startedAt: Date.now() });

  if (!isWindows) return startUnixSupervisor(opts.name, log);
  // Windows: pm2 if available (hidden, restart + logon resurrect), else schtasks.
  if (pm2Available() && startWindowsPm2(opts.name, opts.cwd, opts.argv, log)) return true;
  return startWindowsTask(opts.name, log);
}

/** Windows pm2 backend: pm2 runs the serve argv directly (no supervisor loop —
 *  pm2 owns restart-on-failure), launched hidden. argv[0] is the bun runtime. */
function startWindowsPm2(name: string, cwd: string, argv: string[], log: string): boolean {
  const ok = pm2Start({ name, cwd, script: argv[0], args: argv.slice(1), log });
  if (ok) patch(name, { pm2: name });
  return ok;
}

/** POSIX: detached, unref'd supervisor child that survives as an orphan. */
function startUnixSupervisor(name: string, log: string): boolean {
  const fd = openSync(log, "a");
  const proc = spawn([process.execPath, process.argv[1], "__supervise", "--name", name], {
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  proc.unref();
  if (!proc.pid) return false;
  patch(name, { pid: proc.pid });
  return true;
}

/** Windows: a Scheduled Task running the supervisor, with output redirected to
 *  the log via a small launcher .cmd (avoids schtasks /tr quoting limits). It
 *  auto-starts at logon and is started immediately. */
function startWindowsTask(name: string, log: string): boolean {
  mkdirSync(TASK_DIR, { recursive: true });
  const cmdPath = join(TASK_DIR, `${name}.cmd`);
  const cmd = `@echo off\r\n"${process.execPath}" "${process.argv[1]}" __supervise --name "${name}" >> "${log}" 2>&1\r\n`;
  writeFileSync(cmdPath, cmd);

  // Create the task (onlogon for a normal user; onstart when running elevated as
  // SYSTEM, where there's no interactive logon), then run it now.
  let created = schtasks(["/create", "/tn", name, "/tr", cmdPath, "/sc", "onlogon", "/f"]);
  if (created !== 0) created = schtasks(["/create", "/tn", name, "/tr", cmdPath, "/sc", "onstart", "/f"]);
  if (created !== 0) return false;
  patch(name, { task: name });
  return schtasks(["/run", "/tn", name]) === 0;
}

/** Live daemons. Dead POSIX supervisors are pruned; Windows entries persist as
 *  long as their task is still registered (a Ready task is a valid auto-start). */
export function listFallbackDaemons(): FallbackDaemon[] {
  const list = readRegistry();
  const alive = list.filter((d) =>
    d.pm2 ? pm2Online(d.pm2) : d.task ? taskExists(d.task) : d.pid != null && isAlive(d.pid),
  );
  if (alive.length !== list.length) writeRegistry(alive);
  return alive;
}

/** Stop and deregister a daemon by name. Returns false if not found. */
export function stopFallbackDaemon(name: string): boolean {
  const list = readRegistry();
  const hit = list.find((d) => d.name === name);
  if (!hit) return false;
  if (hit.pm2) {
    pm2Delete(hit.pm2); // pm2 stops + removes the managed process (incl. its child tree)
  } else if (hit.task) {
    schtasks(["/end", "/tn", hit.task]);
    schtasks(["/delete", "/tn", hit.task, "/f"]);
    // /end hard-terminates the task's top process; kill the serve subtree (VS
    // Code) too so it doesn't orphan.
    if (hit.servePid) killProcessTree(hit.servePid);
  } else if (hit.pid != null) {
    try {
      process.kill(hit.pid); // SIGTERM -> supervisor kills its child, then exits
    } catch {
      // already gone
    }
  }
  writeRegistry(list.filter((d) => d.name !== name));
  return true;
}

/**
 * Supervisor body (run via the hidden `__supervise` command). Loads its serve
 * argv + cwd from the registry by name, runs it, and restarts it on a non-zero
 * exit with capped exponential backoff; stops when the child exits cleanly or on
 * SIGTERM/SIGINT (killing the child first).
 */
export async function runSupervisor(name: string): Promise<number> {
  const entry = readRegistry().find((d) => d.name === name);
  if (!entry) {
    console.error(`[codehost:${name}] no registry entry; nothing to supervise.`);
    return 1;
  }
  const { argv, cwd } = entry;

  let child: Subprocess | null = null;
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    try {
      if (child?.pid) killProcessTree(child.pid);
    } catch {
      // ignore
    }
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  let attempt = 0;
  while (!stopping) {
    console.log(`[codehost:${name}] starting: ${argv.join(" ")}`);
    child = spawn(argv, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    patch(name, { servePid: child.pid });
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
