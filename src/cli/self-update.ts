import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Best-effort self-update, run right before a daemon is (re)spawned (see the top
// of launchServeDaemon). Re-launching `setup` or `serve -d` replaces the managed
// daemon (oxmgr delete + start), so upgrading the global package here means the
// fresh daemon process runs the new code — there's no in-place restart, so this
// never trips oxmgr's `on-failure` policy and never drops a live session
// mid-flight. A days-old daemon only updates on the next launcher run.

const REGISTRY_LATEST = "https://registry.npmjs.org/codehost/latest";
const FETCH_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Upgrade the global `codehost` to the latest published version if we're running
 * from a real global install (`bun add -g` / `npm i -g`). A dev checkout or a
 * `bunx` run is left untouched so we never clobber the user's global copy.
 *
 * Fully non-fatal: an offline registry, a slow network, or a failed `bun add`
 * must never stop the server from launching — every failure path just logs and
 * returns. Disable entirely with CODEHOST_NO_SELF_UPDATE=1.
 */
export async function selfUpdate(): Promise<void> {
  if (process.env.CODEHOST_NO_SELF_UPDATE === "1") return;
  try {
    if (!isGlobalInstall()) return; // dev checkout or bunx: don't touch the global

    const installed = currentVersion();
    if (!installed) return; // can't locate our own package.json — don't risk it

    const latest = await fetchLatest();
    if (!latest || latest === installed) return;

    console.log(`[codehost] updating codehost ${installed} → ${latest}…`);
    const r = spawnSync(process.execPath, ["add", "-g", `codehost@${latest}`], {
      stdio: "inherit",
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (r.status === 0) {
      console.log(`[codehost] updated to ${latest}; the new daemon will run it.`);
    } else {
      console.warn(`[codehost] self-update to ${latest} failed; continuing on ${installed}.`);
    }
  } catch (err) {
    console.warn(`[codehost] self-update skipped: ${(err as Error).message}`);
  }
}

/** Version from our own package.json (src/cli → package root is two up). */
function currentVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * True only when this file lives in a well-known *global* package directory we
 * own. Conservative on purpose: anything unrecognized (dev repo, bunx cache,
 * unusual layout) returns false so we skip rather than risk overwriting the
 * wrong tree.
 */
function isGlobalInstall(): boolean {
  const dir = import.meta.dir.replace(/\\/g, "/");
  return (
    dir.includes("/.bun/install/global/node_modules/codehost/") || // bun add -g
    dir.includes("/lib/node_modules/codehost/") // npm i -g (unix default prefix)
  );
}

/** Latest published version per the npm registry, or null on any failure. */
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_LATEST, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}
