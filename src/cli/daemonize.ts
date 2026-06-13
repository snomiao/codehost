import { daemonName, startDaemon } from "./oxmgr";
import { selfUpdate } from "./self-update";
import { startFallbackDaemon } from "./fallback-daemon";

export interface ServeDaemonOptions {
  /** Subcommand to re-launch under oxmgr. */
  command?: "serve" | "dev" | "expose";
  /** Absolute directory to serve (also the oxmgr working dir). */
  dir: string;
  /** Positional argument for the re-launched command (defaults to `dir`); for
   *  `expose` this is the port, while `dir` stays a real cwd for oxmgr. */
  arg?: string;
  /** Room token (already validated). */
  token: string;
  /** Signaling server URL. */
  signal: string;
  /** Display name; also seeds the oxmgr process label. */
  name?: string;
  /** Fixed local VS Code port. */
  port?: number;
  /** Hostname, used as a label fallback. */
  host: string;
  /** Client admission policy ("auto" | "confirm"); propagated to the daemon. */
  approve?: string;
  /** Pre-approved client label patterns, propagated to the daemon. */
  allow?: string[];
}

export interface ServeDaemonResult {
  ok: boolean;
  /** oxmgr process name this server was registered under. */
  name: string;
}

/**
 * Launch a foreground `codehost serve` (without -d) so it survives the shell and
 * restarts on failure. Prefers oxmgr (which also adds login auto-start); when
 * oxmgr can't run here (e.g. broken native binary on Windows) it falls back to a
 * detached, self-restarting child instead of failing. `CODEHOST_NO_OXMGR=1`
 * forces the fallback. Shared by `serve -d` and `setup`.
 */
export async function launchServeDaemon(opts: ServeDaemonOptions): Promise<ServeDaemonResult> {
  // Upgrade the global install (if that's how we're running) before spawning, so
  // the fresh daemon runs the latest code. startDaemon does delete+start, so a
  // re-launch replaces any live daemon with the updated one. Non-fatal.
  await selfUpdate();

  const label = opts.name ?? opts.dir.split("/").pop() ?? opts.host;
  const name = daemonName(label);
  const argv = buildForegroundArgv(opts);

  if (process.env.CODEHOST_NO_OXMGR !== "1") {
    console.log(`[codehost] starting daemon "${name}" via oxmgr`);
    // startDaemon attempts to self-heal oxmgr once; false means it's unusable here.
    const ok = await startDaemon({ name, command: argv.map(quote).join(" "), cwd: opts.dir });
    if (ok) {
      console.log(`[codehost] daemon started. View: codehost list · Stop: codehost stop ${name}`);
      return { ok: true, name };
    }
    console.warn("[codehost] oxmgr unavailable — falling back to a detached daemon (no login auto-start).");
  }

  const ok = startFallbackDaemon({ name, argv, cwd: opts.dir });
  if (ok) {
    console.log(`[codehost] detached daemon "${name}" started. View: codehost list · Stop: codehost stop ${name}`);
  } else {
    console.error("[codehost] failed to start a detached daemon.");
  }
  return { ok, name };
}

/**
 * Reconstruct the exact foreground `serve` invocation (without -d) as an argv
 * array. Uses the same runtime + entry script that launched us, so it works both
 * for `bunx codehost` and local `bun src/cli/index.ts`. oxmgr takes a shell
 * string (we quote+join); the fallback spawns the argv directly.
 */
function buildForegroundArgv(opts: ServeDaemonOptions): string[] {
  const parts = [process.execPath, process.argv[1], opts.command ?? "serve", opts.arg ?? opts.dir, "-t", opts.token, "--signal", opts.signal];
  if (opts.name) parts.push("--name", opts.name);
  if (opts.port) parts.push("--port", String(opts.port));
  // An oxmgr-managed `dev` must stay a real daemon across restarts/reboots —
  // never collapse into register-with-the-host-daemon-and-exit (oxmgr would
  // see an instant exit and thrash).
  if ((opts.command ?? "serve") === "dev") parts.push("--standalone");
  // A backgrounded daemon has no terminal, so "confirm" can only admit clients
  // that match an --allow pattern; we still propagate it so that works.
  if (opts.approve && opts.approve !== "auto") parts.push("--approve", opts.approve);
  for (const pat of opts.allow ?? []) parts.push("--allow", pat);
  return parts;
}

function quote(s: string): string {
  return /[^A-Za-z0-9_\/:=.-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}
