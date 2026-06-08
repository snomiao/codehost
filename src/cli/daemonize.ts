import { daemonName, startDaemon } from "./oxmgr";
import { selfUpdate } from "./self-update";

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
}

export interface ServeDaemonResult {
  ok: boolean;
  /** oxmgr process name this server was registered under. */
  name: string;
}

/**
 * Launch a foreground `codehost serve` (without -d) under oxmgr so it survives
 * the shell and restarts on failure. Shared by `serve -d` and `setup`.
 */
export async function launchServeDaemon(opts: ServeDaemonOptions): Promise<ServeDaemonResult> {
  // Upgrade the global install (if that's how we're running) before spawning, so
  // the fresh daemon runs the latest code. startDaemon does delete+start, so a
  // re-launch replaces any live daemon with the updated one. Non-fatal.
  await selfUpdate();

  const label = opts.name ?? opts.dir.split("/").pop() ?? opts.host;
  const name = daemonName(label);
  const command = buildForegroundCommand(opts);
  console.log(`[codehost] starting daemon "${name}" via oxmgr`);
  const ok = await startDaemon({ name, command, cwd: opts.dir });
  if (ok) {
    console.log(`[codehost] daemon started. View: codehost list · Stop: codehost stop ${name}`);
  }
  return { ok, name };
}

/**
 * Reconstruct the exact foreground `serve` invocation (without -d) for oxmgr to
 * run. Uses the same runtime + entry script that launched us, so it works both
 * for `bunx codehost` and local `bun src/cli/index.ts`.
 */
function buildForegroundCommand(opts: ServeDaemonOptions): string {
  const parts = [process.execPath, process.argv[1], opts.command ?? "serve", opts.arg ?? opts.dir, "-t", opts.token, "--signal", opts.signal];
  if (opts.name) parts.push("--name", opts.name);
  if (opts.port) parts.push("--port", String(opts.port));
  return parts.map(quote).join(" ");
}

function quote(s: string): string {
  return /[^A-Za-z0-9_\/:=.-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}
