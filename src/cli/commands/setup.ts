import { hostname } from "node:os";
import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { generateToken, validateToken, TOKEN_REQUIREMENTS } from "../../shared/token";
import { readConfig, writeConfig } from "../config";
import { launchServeDaemon } from "../daemonize";
import { resolveCodeBinary } from "../vscode-install";
import { DEFAULT_SIGNAL_URL } from "./serve";

const PAGE_URL = "https://codehost.dev";

interface SetupArgs {
  dir: string;
  token?: string;
  newToken: boolean;
  name?: string;
  signal: string;
  port?: number;
}

export const setupCommand: CommandModule<{}, SetupArgs> = {
  command: "setup [dir]",
  describe: "One-shot: pick a token, ensure VS Code, and start a daemonized server",
  builder: (y) =>
    y
      .positional("dir", { describe: "Directory to serve (defaults to cwd)", type: "string", default: "." })
      .option("token", {
        alias: "t",
        describe: "Room token (generated + saved if omitted)",
        type: "string",
      })
      .option("new-token", {
        describe: "Generate a fresh token even if one is saved",
        type: "boolean",
        default: false,
      })
      .option("name", { describe: "Display name for this server (defaults to hostname)", type: "string" })
      .option("signal", { describe: "Signaling server URL", type: "string", default: DEFAULT_SIGNAL_URL })
      .option("port", { describe: "Fixed port for the local VS Code server", type: "number" }) as any,
  handler: async (argv) => {
    const dir = resolve(process.cwd(), argv.dir);
    const host = hostname();

    // 1. Resolve the room token: validate an explicit one, otherwise reuse the
    //    saved token (stable room URL) or mint and persist a strong new one.
    const token = resolveToken(argv);
    console.log(`[codehost] room token: ${token}`);

    // 2. Make sure a working VS Code is available, installing/upgrading the
    //    managed CLI if the system `code` is missing or broken. Doing it here
    //    surfaces download progress before we hand off to the daemon.
    console.log("[codehost] checking VS Code…");
    const codeBin = await resolveCodeBinary();
    console.log(`[codehost] using VS Code: ${codeBin}`);

    // 3. Start the WebRTC + VS Code server under oxmgr.
    const { ok, name } = await launchServeDaemon({
      dir,
      token,
      signal: argv.signal,
      name: argv.name,
      port: argv.port,
      host,
    });
    if (!ok) process.exit(1);

    // 4. Tell the user how to connect.
    console.log("");
    console.log(`[codehost] ✓ server "${name}" is live, serving ${dir}`);
    console.log(`[codehost] open ${PAGE_URL} and enter your token to connect.`);
    console.log(`[codehost] manage it with: codehost list · codehost stop ${name}`);
  },
};

function resolveToken(argv: SetupArgs): string {
  if (argv.token) {
    const t = argv.token.trim();
    const check = validateToken(t);
    if (!check.ok) {
      console.error(`[codehost] ${check.reason}`);
      console.error(`[codehost] room token requires: ${TOKEN_REQUIREMENTS}`);
      process.exit(1);
    }
    // Persist an explicit token too, so later `setup` runs reuse the same room.
    writeConfig({ ...readConfig(), token: t });
    return t;
  }

  const config = readConfig();
  if (config.token && !argv.newToken) return config.token;

  const token = generateToken();
  writeConfig({ ...config, token });
  console.log("[codehost] generated a new room token (saved to ~/.codehost/config.json)");
  return token;
}
