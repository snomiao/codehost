import { spawnSync } from "node:child_process";

// Thin wrapper around the `oxmgr` process manager (https://npmjs.com/package/oxmgr).
// `codehost serve -d` re-launches the foreground `serve` under oxmgr so it
// survives the shell and restarts on failure.

export function hasOxmgr(): boolean {
  const r = spawnSync("oxmgr", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

const MISSING_MSG =
  "[codehost] oxmgr not found. Install it with `npm i -g oxmgr` (or `bun add -g oxmgr`), then retry with -d.";

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

/** Start the foreground serve under oxmgr. Returns false if oxmgr is missing. */
export function startDaemon(opts: DaemonizeOptions): boolean {
  if (!hasOxmgr()) {
    console.error(MISSING_MSG);
    return false;
  }
  // Replace any previous instance with the same name.
  spawnSync("oxmgr", ["delete", opts.name], { stdio: "ignore" });

  const r = spawnSync(
    "oxmgr",
    ["start", opts.command, "--name", opts.name, "--cwd", opts.cwd, "--restart", "on-failure"],
    { stdio: "inherit" },
  );
  return r.status === 0;
}

/** `codehost list` -> oxmgr's process table. */
export function listDaemons(): number {
  if (!hasOxmgr()) {
    console.error(MISSING_MSG);
    return 1;
  }
  const r = spawnSync("oxmgr", ["list"], { stdio: "inherit" });
  return r.status ?? 0;
}

/** `codehost stop <name>` -> stop + delete the oxmgr process. */
export function stopDaemon(name: string): number {
  if (!hasOxmgr()) {
    console.error(MISSING_MSG);
    return 1;
  }
  const full = name.startsWith("codehost-") ? name : daemonName(name);
  spawnSync("oxmgr", ["stop", full], { stdio: "inherit" });
  const r = spawnSync("oxmgr", ["delete", full], { stdio: "inherit" });
  return r.status ?? 0;
}
