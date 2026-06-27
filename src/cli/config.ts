import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// Persistent CLI config under ~/.codehost (same root as the managed VS Code
// cache in vscode-install.ts): the reusable room token and this machine's
// stable hostId.

const CONFIG_FILE = join(homedir(), ".codehost", "config.json");

export interface CliConfig {
  /** Room token reused by `setup` until --new-token or an explicit -t. */
  token?: string;
  /** Stable machine identity (UUID), minted once on first use. Every daemon on
   *  this machine advertises it, so the web UI can group peers by host and
   *  history entries survive daemon restarts (peerIds are per-process). */
  hostId?: string;
  /** Workspace root remembered from an explicit `codehost setup <dir>` —
   *  reused when serve/setup run with no dir. Absent -> ~/ws. */
  root?: string;
}

export function readConfig(file: string = CONFIG_FILE): CliConfig {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig, file: string = CONFIG_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
}

/** The workspace root to use when no dir was given: the remembered root from
 *  config, else ~/ws (created on demand by the caller). Never $HOME itself. */
export function defaultRoot(file: string = CONFIG_FILE): string {
  return readConfig(file).root || join(homedir(), "ws");
}

/** This machine's OS login name, advertised so the web UI can show a
 *  `user@host` label. Falls back to $USER/$USERNAME, then "unknown" —
 *  os.userInfo() throws when the uid has no passwd entry (some containers). */
export function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

/** This machine's persistent hostId, minting + saving it on first call. */
export function ensureHostId(file: string = CONFIG_FILE): string {
  const config = readConfig(file);
  if (config.hostId) return config.hostId;
  const hostId = crypto.randomUUID();
  writeConfig({ ...config, hostId }, file);
  return hostId;
}
