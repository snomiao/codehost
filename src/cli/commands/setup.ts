import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { generateToken, validateToken, TOKEN_REQUIREMENTS } from "../../shared/token";
import { defaultRoot, readConfig, writeConfig } from "../config";
import { launchServeDaemon } from "../daemonize";
import { isGitRepo } from "../git";
import { scaffoldCodehost } from "../init";
import { confirmRiskyRoot } from "./serve";
import { resolveCodeBinary } from "../vscode-install";
import { announceConnect } from "../open-url";
import { DEFAULT_SIGNAL_URL } from "./serve";

interface SetupArgs {
  dir?: string;
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
      .positional("dir", {
        describe: "Directory to serve (default: a git cwd serves itself, else the remembered root / ~/ws)",
        type: "string",
      })
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
    // Explicit dir > a git cwd (serve THIS repo) > remembered root > ~/ws —
    // so a bare `codehost setup` (e.g. from the installer) lands on a sane
    // workspace root instead of whatever directory it happened to run in.
    let dir: string;
    if (argv.dir) {
      dir = resolve(process.cwd(), argv.dir);
    } else if (isGitRepo(process.cwd())) {
      dir = process.cwd();
    } else {
      dir = defaultRoot();
      mkdirSync(dir, { recursive: true });
      console.log(`[codehost] no dir given — using workspace root ${dir}`);
    }
    if (!(await confirmRiskyRoot(dir))) {
      console.error("[codehost] aborted");
      process.exit(1);
    }
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

    // 3. Batteries included: a workspace root gets its `.codehost/` scaffold
    //    (config.yaml + clone/worktree setup hook) so /gh/<owner>/<repo> links
    //    provision on demand out of the box. Existing files are never touched;
    //    no new trust — the room token already grants code execution.
    const root = !isGitRepo(dir);
    if (root) {
      const written = scaffoldCodehost(dir);
      if (written.length > 0) {
        console.log(`[codehost] scaffolded ${dir}/.codehost (config.yaml + setup hook — edit freely)`);
      }
      // Remember an explicitly chosen root so future bare runs reuse it.
      if (argv.dir) writeConfig({ ...readConfig(), root: dir });
    }

    // 4. Start the WebRTC + VS Code server under oxmgr. A git repo is a single
    //    workspace (`dev`); anything else is treated as a root (`serve`).
    const { ok, name } = await launchServeDaemon({
      command: root ? "serve" : "dev",
      dir,
      token,
      signal: argv.signal,
      name: argv.name,
      port: argv.port,
      host,
    });
    if (!ok) process.exit(1);

    // 5. Tell the user how to connect, and open the browser straight at the
    //    token-carrying URL so VS Code loads without typing the token in.
    console.log("");
    console.log(`[codehost] ✓ server "${name}" is live, serving ${dir}`);
    announceConnect(token);
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
