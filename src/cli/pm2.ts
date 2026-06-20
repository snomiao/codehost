import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// Windows daemon backend built on pm2 (https://pm2.keymetrics.io/). oxmgr's
// native binary tends to hang/fail on Windows, so `serve -d` / `setup` manage the
// foreground server with pm2 instead — it's a battle-tested, restart-on-failure
// process manager the user likely already runs.
//
// Two Windows-specific wrinkles this module handles:
//   1. pm2 is invoked via its resolved JS entry under the current runtime (bun) —
//      never the bare `pm2` command, whose PATH shim has no .exe/.cmd extension
//      so spawnSync can't resolve it (same trap as oxmgr).
//   2. Starting pm2 (which forks its God daemon + the managed child) is routed
//      through a hidden VBScript launcher so no console window ever flashes. A
//      plain spawn with windowsHide isn't enough — the detached daemon and its
//      fork would still pop their own windows.

const require = createRequire(import.meta.url);
const ROOT = join(homedir(), ".codehost");
const TASK_DIR = join(ROOT, "tasks");

/** Resolve pm2's CLI entry from a local dep or the bun/npm global install. */
export function pm2Entry(): string | null {
  const attempts: Array<() => string> = [
    () => require.resolve("pm2/bin/pm2"),
    () => createRequire(join(bunGlobalRoot(), "_")).resolve("pm2/bin/pm2"),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // try next
    }
  }
  return null;
}

/** Where `bun add -g` drops global packages. */
function bunGlobalRoot(): string {
  const base = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
  return join(base, "install", "global", "node_modules");
}

/** True if a runnable pm2 is resolvable (so the Windows fallback can use it). */
export function hasPm2(): boolean {
  return pm2Entry() != null;
}

/** Run the pm2 CLI under the current runtime (bun). Window stays hidden. */
function pm2(args: string[], opts: SpawnSyncOptions = {}) {
  const entry = pm2Entry();
  if (!entry) return { status: 1, stdout: "", stderr: "" } as const;
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", windowsHide: true, ...opts });
}

/**
 * Start (replacing any same-named instance) `script args` under pm2 with logs
 * redirected to `log`, launched hidden so no window appears, and persist the
 * process list (`pm2 save`). Returns true once pm2 reports the process online.
 *
 * Reboot auto-start is intentionally left to pm2's own startup integration
 * (`pm2 save` records the list for `pm2 resurrect`): the Startup folder is often
 * blocked by Controlled Folder Access and `schtasks /create` needs elevation, so
 * auto-installing a logon hook here can't be done reliably.
 */
export function pm2Start(opts: { name: string; cwd: string; script: string; args: string[]; log: string }): boolean {
  const entry = pm2Entry();
  if (!entry) return false;

  // `--interpreter none` execs the script (bun.exe) directly with the args after
  // `--`, instead of trying to run it through node.
  const start = [
    process.execPath, entry, "start", opts.script,
    "--name", opts.name,
    "--cwd", opts.cwd,
    "--interpreter", "none",
    "--output", opts.log,
    "--error", opts.log,
    "--restart-delay", "2000",
    "--", ...opts.args,
  ];
  const save = [process.execPath, entry, "save", "--force"];
  runHidden([start, save], opts.name);

  // pm2 start is synchronous (the hidden launcher waits), so liveness is the
  // source of truth — more reliable than the launcher's exit code, which is the
  // .cmd's last line.
  return pm2Online(opts.name);
}

/** True if pm2 currently has `name` online. */
export function pm2Online(name: string): boolean {
  const r = pm2(["jlist"]);
  if (r.status !== 0 || !r.stdout) return false;
  try {
    const list = JSON.parse(String(r.stdout)) as Array<{ name: string; pm2_env?: { status?: string } }>;
    return list.some((p) => p.name === name && p.pm2_env?.status === "online");
  } catch {
    return false;
  }
}

/** Stop + deregister a pm2-managed daemon and re-save the list. */
export function pm2Delete(name: string): void {
  pm2(["delete", name], { stdio: "ignore" });
  pm2(["save", "--force"], { stdio: "ignore" });
}

/**
 * Run one or more command argv's hidden, in order, waiting for completion. Writes
 * a launcher .cmd (so we get normal Windows quoting, not VBS string escaping) and
 * a .vbs that runs it with window style 0 via wscript (no console host at all).
 */
function runHidden(commands: string[][], name: string): void {
  mkdirSync(TASK_DIR, { recursive: true });
  const cmdPath = join(TASK_DIR, `${name}.pm2.cmd`);
  const vbsPath = join(TASK_DIR, `${name}.pm2.vbs`);
  const body = ["@echo off", ...commands.map(quoteCmd)].join("\r\n") + "\r\n";
  writeFileSync(cmdPath, body);
  // Hidden launcher: wscript (no console host) runs the .cmd with window style 0
  // and waits. The path is wrapped in literal quotes — in VBS source a `"` inside
  // a string is written `""`, so a quoted path becomes `"""<path>"""`.
  writeFileSync(vbsPath, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${cmdPath}""", 0, True\r\n`);
  spawnSync("wscript", ["//B", "//Nologo", vbsPath], { windowsHide: true });
}

/** Quote an argv into a single cmd.exe command line. Paths/tokens here never
 *  contain double quotes, so simple space-aware quoting is sufficient. */
function quoteCmd(argv: string[]): string {
  return argv.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a)).join(" ");
}
