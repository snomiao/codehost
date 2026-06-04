import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Resolves a runnable VS Code CLI binary for `code serve-web`. Strategy
// ("managed, prefer system"): honor an explicit override, then a system `code`
// on PATH, otherwise download + cache Microsoft's standalone ~31MB "VS Code
// CLI" binary for this platform. The standalone CLI fully supports serve-web
// with the same flags as a full install. Update cadence is "check but cache":
// the managed binary's version is re-checked against the stable channel at most
// once per ~24h; otherwise the cached binary is used with no network call.

const CACHE_ROOT = join(homedir(), ".codehost", "vscode");
const STATE_FILE = join(CACHE_ROOT, "state.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_API = "https://update.code.visualstudio.com/api/update";

interface Manifest {
  url: string;
  version: string;
  productVersion: string;
  sha256hash: string;
}

interface State {
  /** Commit-style version id from the manifest. */
  version: string;
  /** Human version, e.g. "1.123.0". */
  productVersion: string;
  /** Absolute path to the extracted `code`/`code.exe`. */
  binPath: string;
  /** Wall-clock ms of the last manifest check. */
  checkedAt: number;
}

/**
 * Return a path (or bare `"code"`) that can be spawned to run `serve-web`.
 * Downloads and caches the standalone CLI on first use when no system VS Code
 * is available. `opts.force` skips the 24h throttle (used by `codehost update`).
 */
export async function resolveCodeBinary(opts: { force?: boolean } = {}): Promise<string> {
  const override = process.env.CODEHOST_CODE_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CODEHOST_CODE_BIN points to a missing file: ${override}`);
    }
    return override;
  }

  // Prefer a user-owned `code` on PATH; we don't manage its updates.
  const system = Bun.which("code");
  if (system) return system;

  return ensureManagedBinary(opts.force ?? false);
}

async function ensureManagedBinary(force: boolean): Promise<string> {
  const key = platformKey();
  const state = readState();

  const fresh = state && existsSync(state.binPath) && Date.now() - state.checkedAt < CHECK_INTERVAL_MS;
  if (fresh && !force) return state!.binPath;

  let manifest: Manifest;
  try {
    manifest = await fetchManifest(key);
  } catch (err) {
    // Offline: fall back to whatever we have cached, otherwise fail loudly.
    if (state && existsSync(state.binPath)) {
      console.warn(`[codehost] could not check for VS Code updates (${(err as Error).message}); using cached ${state.productVersion}`);
      return state.binPath;
    }
    throw new Error(
      `Unable to download VS Code and none is cached: ${(err as Error).message}. ` +
        `Install VS Code's \`code\` CLI manually, or set CODEHOST_CODE_BIN to an existing binary.`,
    );
  }

  // Already on the latest stable: just refresh the throttle timestamp.
  if (state && state.version === manifest.version && existsSync(state.binPath)) {
    writeState({ ...state, checkedAt: Date.now() });
    return state.binPath;
  }

  console.log(`[codehost] installing VS Code ${manifest.productVersion} (${key})…`);
  const binPath = await downloadAndExtract(manifest, key);
  writeState({
    version: manifest.version,
    productVersion: manifest.productVersion,
    binPath,
    checkedAt: Date.now(),
  });
  console.log(`[codehost] VS Code ${manifest.productVersion} ready at ${binPath}`);
  return binPath;
}

/** Map this host to a `cli-<os>-<arch>` key understood by the update API. */
function platformKey(): string {
  const arch = process.arch; // "x64" | "arm64" | "arm" | ...
  if (process.platform === "darwin") {
    return arch === "arm64" ? "cli-darwin-arm64" : "cli-darwin-x64";
  }
  if (process.platform === "win32") {
    return arch === "arm64" ? "cli-win32-arm64" : "cli-win32-x64";
  }
  // Linux: distinguish musl (Alpine) from glibc, and map arch.
  const os = isMusl() ? "alpine" : "linux";
  if (arch === "arm64") return `cli-${os}-arm64`;
  if (arch === "arm") return `cli-${os}-armhf`;
  return `cli-${os}-x64`;
}

function isMusl(): boolean {
  if (existsSync("/etc/alpine-release")) return true;
  // `ldd --version` mentions "musl" on musl systems; ignore failures.
  const r = spawnSync("ldd", ["--version"], { encoding: "utf8" });
  return /musl/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

async function fetchManifest(key: string): Promise<Manifest> {
  const res = await fetch(`${UPDATE_API}/${key}/stable/latest`);
  if (!res.ok) throw new Error(`manifest HTTP ${res.status} for ${key}`);
  const m = (await res.json()) as Partial<Manifest>;
  if (!m.url || !m.version || !m.sha256hash) {
    throw new Error(`malformed manifest for ${key}`);
  }
  return {
    url: m.url,
    version: m.version,
    productVersion: m.productVersion ?? m.version,
    sha256hash: m.sha256hash,
  };
}

async function downloadAndExtract(manifest: Manifest, key: string): Promise<string> {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const isZip = manifest.url.endsWith(".zip");
  const tmpArchive = join(tmpdir(), `codehost-vscode-${manifest.version}${isZip ? ".zip" : ".tar.gz"}`);

  const res = await fetch(manifest.url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  await Bun.write(tmpArchive, res);

  await verifySha256(tmpArchive, manifest.sha256hash);

  // Extract into a fresh temp dir, then move the single binary into the cache.
  const extractDir = join(tmpdir(), `codehost-vscode-x-${manifest.version}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  // bsdtar (macOS / Windows 10+) extracts .zip via `tar -xf`; GNU tar handles
  // the Linux .tar.gz with `-xzf`.
  const tarArgs = isZip ? ["-xf", tmpArchive] : ["-xzf", tmpArchive];
  const tar = spawnSync("tar", [...tarArgs, "-C", extractDir], { encoding: "utf8" });
  if (tar.status !== 0) {
    throw new Error(`failed to extract VS Code archive: ${tar.stderr ?? tar.error?.message ?? "tar error"}`);
  }

  const exe = process.platform === "win32" ? "code.exe" : "code";
  const found = await findFile(extractDir, exe);
  if (!found) throw new Error(`extracted archive did not contain ${exe}`);

  const destDir = join(CACHE_ROOT, manifest.version);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const destBin = join(destDir, exe);
  renameSync(found, destBin);
  if (process.platform !== "win32") {
    const { chmodSync } = await import("node:fs");
    chmodSync(destBin, 0o755);
  }

  rmSync(tmpArchive, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  return destBin;
}

async function verifySha256(path: string, expected: string): Promise<void> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  const actual = hasher.digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    rmSync(path, { force: true });
    throw new Error(`sha256 mismatch (expected ${expected}, got ${actual})`);
  }
}

/** Shallow-first search for a file named `name` under `dir`. */
async function findFile(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name === name) return join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = await findFile(join(dir, e.name), name);
      if (hit) return hit;
    }
  }
  return null;
}

function readState(): State | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return null;
  }
}

function writeState(state: State): void {
  mkdirSync(CACHE_ROOT, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
