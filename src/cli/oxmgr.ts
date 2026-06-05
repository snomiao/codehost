import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { healOxmgr } from "./oxmgr-heal";

// Wrapper around the `oxmgr` process manager (https://npmjs.com/package/oxmgr),
// used by `serve|dev|expose -d` to run the foreground command as a managed,
// restart-on-failure daemon.
//
// oxmgr is a *dependency* of codehost, and we invoke it via the current runtime
// (bun) using its resolved JS entry — never the bare `oxmgr` command. That
// avoids the Windows failure where `spawnSync("oxmgr")` can't resolve a PATH
// shim without the .exe/.cmd extension, and needs no Node and no global install.

const require = createRequire(import.meta.url);

/** Resolve oxmgr's JS CLI entry from codehost's own node_modules. */
function oxmgrEntry(): string | null {
  try {
    return require.resolve("oxmgr/bin/oxmgr.js");
  } catch {
    return null;
  }
}

/** Run the oxmgr CLI via bun. Returns the exit status (1 if unresolvable). */
function ox(args: string[], opts: SpawnSyncOptions = {}): number {
  const entry = oxmgrEntry();
  if (!entry) return 1;
  const r = spawnSync(process.execPath, [entry, ...args], opts);
  return r.status ?? 1;
}

type OxmgrState = "ok" | "broken" | "missing";

/** Probe oxmgr: "missing" = not installed; "broken" = installed but its binary
 *  won't run (no vendored prebuilt yet, or a glibc/platform mismatch). */
function probeOxmgr(): OxmgrState {
  const entry = oxmgrEntry();
  if (!entry) return "missing";
  const r = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8" });
  return r.status === 0 ? "ok" : "broken";
}

/** Quick non-repairing probe (used where we only need a yes/no). */
export function hasOxmgr(): boolean {
  return probeOxmgr() === "ok";
}

/**
 * Ensure a runnable oxmgr, self-healing a broken/missing prebuilt (see
 * oxmgr-heal.ts) — the common case under bunx/bun where install lifecycle
 * scripts are skipped so oxmgr's binary was never downloaded. Returns true if
 * oxmgr is usable afterwards.
 */
export async function ensureOxmgr(): Promise<boolean> {
  const state = probeOxmgr();
  if (state === "ok") return true;
  if (state === "missing") {
    console.error(MISSING_MSG);
    return false;
  }
  if (await healOxmgr()) return probeOxmgr() === "ok";
  console.error(BROKEN_MSG);
  return false;
}

const MISSING_MSG =
  "[codehost] oxmgr is not available. Reinstall codehost so its dependency is present " +
  "(`bun add -g codehost` or `npm i -g codehost`), then retry with -d.";

const BROKEN_MSG =
  "[codehost] oxmgr is installed but its native binary couldn't be fetched/repaired " +
  "automatically (check network access). Foreground `codehost serve` (without -d) still works.";

/** Process name oxmgr will track this server under. */
export function daemonName(label: string): string {
  const slug = label.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `codehost-${slug || "server"}`;
}

export interface DaemonizeOptions {
  name: string; // oxmgr process name
  command: string; // full inline command oxmgr should run (the foreground serve)
  cwd: string;
}

/** Start the foreground serve under oxmgr. Returns false if oxmgr is unusable. */
export async function startDaemon(opts: DaemonizeOptions): Promise<boolean> {
  if (!(await ensureOxmgr())) return false;
  // Replace any previous instance with the same name.
  ox(["delete", opts.name], { stdio: "ignore" });

  const ok =
    ox(
      ["start", opts.command, "--name", opts.name, "--cwd", opts.cwd, "--restart", "on-failure"],
      { stdio: "inherit" },
    ) === 0;
  if (ok) enableStartup();
  return ok;
}

/**
 * Best-effort: install oxmgr's platform service (systemd `--user` / launchd /
 * Task Scheduler) so the daemon — and the codehost process it manages, whose
 * metadata oxmgr persists — comes back when the user logs in again. Idempotent
 * and non-fatal: hosts without an init system just get a hint.
 */
function enableStartup(): void {
  const ok = ox(["service", "--system", "auto", "install"], { stdio: "pipe" }) === 0;
  if (ok) {
    console.log("[codehost] login auto-start enabled (oxmgr service installed)");
  } else {
    console.log(
      "[codehost] note: couldn't auto-enable login startup here; run oxmgr's `startup` " +
        "integration on a systemd/launchd host to make it persist across logins.",
    );
  }
}

/** `codehost list` -> oxmgr's process table. */
export async function listDaemons(): Promise<number> {
  if (!(await ensureOxmgr())) return 1;
  return ox(["list"], { stdio: "inherit" });
}

/** `codehost stop <name>` -> stop + delete the oxmgr process. */
export async function stopDaemon(name: string): Promise<number> {
  if (!(await ensureOxmgr())) return 1;
  const full = name.startsWith("codehost-") ? name : daemonName(name);
  ox(["stop", full], { stdio: "inherit" });
  return ox(["delete", full], { stdio: "inherit" });
}
