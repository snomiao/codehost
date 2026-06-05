import { spawnSync } from "node:child_process";
import { healOxmgr } from "./oxmgr-heal";

// Thin wrapper around the `oxmgr` process manager (https://npmjs.com/package/oxmgr).
// `codehost serve -d` re-launches the foreground `serve` under oxmgr so it
// survives the shell and restarts on failure.

type OxmgrState = "ok" | "broken" | "missing";

/** Probe the oxmgr binary, distinguishing "won't run" from "not installed". */
function probeOxmgr(): OxmgrState {
  const r = spawnSync("oxmgr", ["--version"], { encoding: "utf8" });
  if (r.status === 0) return "ok";
  // ENOENT from the spawn itself => the command isn't on PATH at all.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "missing";
  // Installed, but the prebuilt won't execute — typically `GLIBC_x.y not found`
  // on older distros. Repairable by swapping in oxmgr's static musl build.
  return "broken";
}

/** Quick non-repairing probe (used where we only need a yes/no). */
export function hasOxmgr(): boolean {
  return probeOxmgr() === "ok";
}

/**
 * Ensure a runnable oxmgr, self-healing a broken prebuilt by swapping in the
 * portable musl static build (see oxmgr-heal.ts). Returns true if oxmgr is
 * usable afterwards; otherwise prints an actionable message.
 */
export async function ensureOxmgr(): Promise<boolean> {
  const state = probeOxmgr();
  if (state === "ok") return true;
  if (state === "missing") {
    console.error(MISSING_MSG);
    return false;
  }
  // "broken": attempt the musl repair, then re-probe.
  if (await healOxmgr()) return probeOxmgr() === "ok";
  console.error(BROKEN_MSG);
  return false;
}

const MISSING_MSG =
  "[codehost] oxmgr not found. Install it with `npm i -g oxmgr` (or `bun add -g oxmgr`), then retry with -d.";

const BROKEN_MSG =
  "[codehost] oxmgr is installed but its prebuilt binary won't run on this system " +
  "(often an old glibc), and automatic repair failed. Reinstall oxmgr, or run on a " +
  "host whose glibc matches its prebuilt. Foreground `codehost serve` (without -d) still works.";

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
  spawnSync("oxmgr", ["delete", opts.name], { stdio: "ignore" });

  const r = spawnSync(
    "oxmgr",
    ["start", opts.command, "--name", opts.name, "--cwd", opts.cwd, "--restart", "on-failure"],
    { stdio: "inherit" },
  );
  if (r.status === 0) enableStartup();
  return r.status === 0;
}

/**
 * Best-effort: install oxmgr's platform service (systemd `--user` / launchd /
 * Task Scheduler) so the daemon — and the codehost process it manages, whose
 * metadata oxmgr persists — comes back when the user logs in again. Idempotent
 * and non-fatal: hosts without an init system just get a hint.
 */
function enableStartup(): void {
  const r = spawnSync("oxmgr", ["service", "--system", "auto", "install"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status === 0) {
    console.log("[codehost] login auto-start enabled (oxmgr service installed)");
  } else {
    console.log(
      "[codehost] note: couldn't auto-enable login startup here; run `oxmgr startup` " +
        "on a systemd/launchd host to make it persist across logins.",
    );
  }
}

/** `codehost list` -> oxmgr's process table. */
export async function listDaemons(): Promise<number> {
  if (!(await ensureOxmgr())) return 1;
  const r = spawnSync("oxmgr", ["list"], { stdio: "inherit" });
  return r.status ?? 0;
}

/** `codehost stop <name>` -> stop + delete the oxmgr process. */
export async function stopDaemon(name: string): Promise<number> {
  if (!(await ensureOxmgr())) return 1;
  const full = name.startsWith("codehost-") ? name : daemonName(name);
  spawnSync("oxmgr", ["stop", full], { stdio: "inherit" });
  const r = spawnSync("oxmgr", ["delete", full], { stdio: "inherit" });
  return r.status ?? 0;
}
