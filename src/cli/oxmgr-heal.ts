import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Self-heal oxmgr's native binary. Two real-world gaps:
//   1. Under bunx/bun (and `bun i -g`), install lifecycle scripts are skipped,
//      so oxmgr's postinstall never downloads its prebuilt — the vendored
//      binary is simply absent.
//   2. On older Linux distros, the downloaded `*-linux-gnu` prebuilt needs a
//      newer glibc than the host has (GLIBC_x.y not found).
// Linux is healed by swapping in oxmgr's fully static `*-linux-musl` build (no
// libc dependency, also covers the missing case). Other platforms are healed by
// running oxmgr's own installer via the current runtime (bun) to fetch the
// right binary — no Node required. Mirrors the node-datachannel self-heal.

const require = createRequire(import.meta.url);
let healAttempted = false;

interface OxmgrInstall {
  /** oxmgr package root. */
  root: string;
  /** Platform-correct vendored binary path. */
  vendorBin: string;
  version: string;
  /** GitHub "owner/repo" the release assets live under. */
  slug: string;
}

/** Repair oxmgr's binary. Idempotent within a process. */
export async function healOxmgr(): Promise<boolean> {
  if (healAttempted) return false;
  healAttempted = true;

  const install = locateOxmgr();
  if (!install) return false;

  // Linux: portable musl static build covers both the glibc mismatch and a
  // missing binary in one download.
  if (process.platform === "linux") return swapMusl(install);

  // Windows / macOS: run oxmgr's own installer to fetch the platform binary the
  // skipped postinstall never downloaded.
  return runInstaller(install);
}

/** Run oxmgr's bundled installer via the current runtime (bun) to fetch its
 *  native binary. Cross-platform; no Node needed. */
function runInstaller(install: OxmgrInstall): boolean {
  const script = join(install.root, "scripts", "install.js");
  if (!existsSync(script)) return false;
  console.log("[codehost] fetching oxmgr's native binary…");
  const r = spawnSync(process.execPath, [script], { cwd: install.root, stdio: "inherit" });
  return r.status === 0 && existsSync(install.vendorBin);
}

/** Download + install oxmgr's static musl binary (Linux). */
async function swapMusl(install: OxmgrInstall): Promise<boolean> {
  const target = process.arch === "x64" ? "x86_64-unknown-linux-musl" : process.arch === "arm64" ? "aarch64-unknown-linux-musl" : null;
  if (!target) return false;

  const archive = `oxmgr-v${install.version}-${target}.tar.gz`;
  const base =
    process.env.OXMGR_DIST_BASE ||
    `https://github.com/${install.slug}/releases/download/v${install.version}`;
  const url = `${base}/${archive}`;

  const tmp = mkdtempSync(join(tmpdir(), "oxmgr-heal-"));
  const archivePath = join(tmp, archive);
  console.log("[codehost] fetching oxmgr's portable (musl) binary…");
  try {
    await download(url, archivePath);
    const untar = spawnSync("tar", ["xzf", archivePath, "-C", tmp], { stdio: "ignore" });
    if (untar.status !== 0) throw new Error("could not extract the archive (is `tar` installed?)");
    const binary = findFile(tmp, "oxmgr");
    if (!binary) throw new Error("musl archive did not contain an oxmgr binary");
    // Unlink first so we can replace a binary that's currently executing (ETXTBSY).
    rmSync(install.vendorBin, { force: true });
    copyFileSync(binary, install.vendorBin);
    chmodSync(install.vendorBin, 0o755);
    console.log("[codehost] oxmgr repaired with its static musl build.");
    return true;
  } catch (err) {
    console.error(`[codehost] automatic oxmgr repair failed: ${(err as Error).message}`);
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Resolve oxmgr's on-disk install from codehost's own node_modules. */
function locateOxmgr(): OxmgrInstall | null {
  let pkgPath: string;
  try {
    pkgPath = require.resolve("oxmgr/package.json");
  } catch {
    return null;
  }
  const root = dirname(pkgPath);
  const vendorBin = join(root, "vendor", process.platform === "win32" ? "oxmgr.exe" : "oxmgr");

  let pkg: { version?: string; repository?: { url?: string } };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  if (!pkg.version) return null;
  return { root, vendorBin, version: pkg.version, slug: oxmgrSlug(pkg) };
}

/** GitHub slug for oxmgr's releases, matching its own installer's resolution. */
function oxmgrSlug(pkg: { repository?: { url?: string } }): string {
  if (process.env.OXMGR_NPM_REPOSITORY) return process.env.OXMGR_NPM_REPOSITORY;
  const url = pkg.repository?.url ?? "";
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return m ? m[1] : "Vladimir-Urik/OxMgr";
}

/** Download a URL to a file, following GitHub's redirect to release-assets. */
function download(url: string, dest: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 307, 308].includes(status)) {
          const location = res.headers.location;
          file.close();
          rmSync(dest, { force: true });
          if (!location) return reject(new Error(`redirect without location for ${url}`));
          return download(location, dest).then(resolvePromise).catch(reject);
        }
        if (status !== 200) {
          file.close();
          rmSync(dest, { force: true });
          return reject(new Error(`download failed (HTTP ${status})`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolvePromise()));
      })
      .on("error", (err) => {
        file.close();
        rmSync(dest, { force: true });
        reject(err);
      });
  });
}

/** Depth-first search for a file named `name` under `dir`. */
function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}
