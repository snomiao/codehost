import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Persistent CLI config under ~/.codehost (same root as the managed VS Code
// cache in vscode-install.ts). Currently just the reusable room token so
// `codehost setup` lands on a stable room URL across runs.

const CONFIG_FILE = join(homedir(), ".codehost", "config.json");

export interface CliConfig {
  /** Room token reused by `setup` until --new-token or an explicit -t. */
  token?: string;
}

export function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
