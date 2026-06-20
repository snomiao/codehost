import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Importing this module repairs a broken TEMP/TMP as a side effect, as early as
// possible — before any native dep (node-datachannel/bun-pty) or child process
// reads it. See normalizeTempEnv for the why.

/** Expand `%VAR%` references in `value` against `env`; unknown vars are left
 *  as-is. (`%VAR%` is cmd.exe syntax — bun/node/bash never expand it.) */
export function expandWinVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
}

/**
 * Repair an unexpanded TEMP/TMP on Windows. Windows stores them in the registry
 * as REG_EXPAND_SZ — literally `%USERPROFILE%\AppData\Local\Temp` — and some
 * launch contexts (services, scheduled tasks, a parent started by one) pass that
 * string through without expanding it. bun/node/bash don't expand `%VAR%`, so
 * every temp write then resolves *relative to cwd*, littering the working dir
 * with a `%USERPROFILE%/AppData/Local/Temp` tree (we hit ~1GB of this inside
 * provisioned worktrees). Expand it in-process so the server, its native deps,
 * and every spawned child get a real temp dir. Idempotent; no-op off Windows.
 */
export function normalizeTempEnv(): void {
  if (process.platform !== "win32") return;
  for (const key of ["TEMP", "TMP"]) {
    const raw = process.env[key];
    if (!raw || !raw.includes("%")) continue; // already a real path
    const expanded = expandWinVars(raw);
    // If any var was still unresolved, or the dir can't be created, fall back to
    // the canonical per-user temp under the (always-expanded) home dir.
    const fixed = expanded.includes("%") || !ensureDir(expanded) ? fallbackTemp() : expanded;
    process.env[key] = fixed;
  }
}

function fallbackTemp(): string {
  const dir = join(homedir(), "AppData", "Local", "Temp");
  ensureDir(dir);
  return dir;
}

function ensureDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

normalizeTempEnv();
