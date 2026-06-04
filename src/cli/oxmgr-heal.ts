import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Self-heal for the most common oxmgr failure on real-world machines: its
// installer downloads the `*-linux-gnu` prebuilt whenever it detects glibc, but
// that binary is built against a recent glibc (e.g. GLIBC_2.39 from Ubuntu
// 24.04 CI). On older distros (Debian <=12, Ubuntu <=22.04, RHEL/Alma 8-9,
// Amazon Linux 2, ...) it dies at startup with `GLIBC_x.y not found`.
//
// oxmgr also ships a fully static `*-linux-musl` build with no libc dependency
// at all. When the prebuilt won't run we fetch that musl build from oxmgr's own
// GitHub release and swap it into oxmgr's vendor/ dir, then let the caller retry.
// Mirrors the node-datachannel self-heal in rtc-daemon.ts (try -> repair -> retry).

let healAttempted = false;

interface OxmgrInstall {
  /** Path to oxmgr's vendored native binary (the thing that won't run). */
  vendorBin: string;
  /** Installed oxmgr version, e.g. "0.4.0". */
  version: string;
  /** GitHub "owner/repo" the release assets live under. */
  slug: string;
}

/**
 * Repair a broken oxmgr by replacing its prebuilt with the portable musl static
 * build. Returns true if the swap succeeded. Idempotent within a process and a
 * no-op off Linux (the gnu/musl split only exists there).
 */
export async function healOxmgr(): Promise<boolean> {
  if (healAttempted) return false;
  healAttempted = true;

  if (process.platform !== "linux") return false;
  const target = muslTarget();
  if (!target) return false;
  const install = locateOxmgr();
  if (!install) return false;

  const archive = `oxmgr-v${install.version}-${target}.tar.gz`;
  const base =
    process.env.OXMGR_DIST_BASE ||
    `https://github.com/${install.slug}/releases/download/v${install.version}`;
  const url = `${base}/${archive}`;

  const tmp = mkdtempSync(join(tmpdir(), "oxmgr-heal-"));
  const archivePath = join(tmp, archive);
  console.log(
    "[codehost] oxmgr's prebuilt needs a newer glibc than this system has; " +
      "fetching the portable musl build…",
  );
  try {
    await download(url, archivePath);
    const untar = spawnSync("tar", ["xzf", archivePath, "-C", tmp], { stdio: "ignore" });
    if (untar.status !== 0) {
      throw new Error("could not extract the archive (is `tar` installed?)");
    }
    const binary = findFile(tmp, "oxmgr");
    if (!binary) throw new Error("musl archive did not contain an oxmgr binary");
    // Unlink first: replacing a binary that's currently executing fails with
    // ETXTBSY, but removing the directory entry and writing a fresh file is
    // fine (the running process keeps the old inode until it exits).
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

/** Resolve the on-disk oxmgr install from the `oxmgr` command on PATH. */
function locateOxmgr(): OxmgrInstall | null {
  const which = spawnSync("sh", ["-c", "command -v oxmgr"], { encoding: "utf8" });
  const onPath = which.status === 0 ? which.stdout.trim() : "";
  if (!onPath) return null;

  let real: string;
  try {
    real = realpathSync(onPath); // .../node_modules/oxmgr/bin/oxmgr.js
  } catch {
    return null;
  }
  const root = resolve(dirname(real), ".."); // package root
  const vendorBin = join(root, "vendor", "oxmgr");
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg: { version?: string; repository?: { url?: string } };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  if (!pkg.version) return null;
  return { vendorBin, version: pkg.version, slug: oxmgrSlug(pkg) };
}

/** GitHub slug for oxmgr's releases, matching its own installer's resolution. */
function oxmgrSlug(pkg: { repository?: { url?: string } }): string {
  if (process.env.OXMGR_NPM_REPOSITORY) return process.env.OXMGR_NPM_REPOSITORY;
  const url = pkg.repository?.url ?? "";
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return m ? m[1] : "Vladimir-Urik/OxMgr";
}

function muslTarget(): string | null {
  if (process.arch === "x64") return "x86_64-unknown-linux-musl";
  if (process.arch === "arm64") return "aarch64-unknown-linux-musl";
  return null;
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
