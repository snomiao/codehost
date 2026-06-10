import { hostname } from "node:os";
import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import type { PeerMeta } from "../../shared/signaling";
import { DEFAULT_LAYOUT, GITHUB_HOST, toPosixPath } from "../../shared/repo";
import { TOKEN_REQUIREMENTS, validateToken } from "../../shared/token";
import { ensureHostId } from "../config";
import { launchServeDaemon } from "../daemonize";
import { announceConnect } from "../open-url";
import { agentYesPlugin } from "../plugins/agent-yes";
import { withPluginMeta } from "../plugins/types";
import { readCodehostConfig } from "../provision-server";
import { runServer } from "../run-server";
import { launchVscode } from "../vscode";
import { enumerateWorkspaces } from "../workspaces";

export const DEFAULT_SIGNAL_URL = "wss://signal.codehost.dev";

interface ServeArgs {
  dir: string;
  token: string;
  name?: string;
  signal: string;
  daemon: boolean;
  port?: number;
}

export const serveCommand: CommandModule<{}, ServeArgs> = {
  command: "serve [dir]",
  describe:
    "Serve a workspace root over WebRTC; repos under it open via codehost.dev/gh/<owner>/<repo> (or /git/<host>/<owner>/<repo>)",
  builder: (y) =>
    y
      .positional("dir", {
        describe: "Directory to serve (defaults to cwd)",
        type: "string",
        default: ".",
      })
      .option("token", {
        alias: "t",
        describe: "Room token shared with the codehost.dev page",
        type: "string",
        demandOption: true,
      })
      .option("name", {
        describe: "Display name for this server (defaults to hostname)",
        type: "string",
      })
      .option("signal", {
        describe: "Signaling server URL",
        type: "string",
        default: DEFAULT_SIGNAL_URL,
      })
      .option("daemon", {
        alias: "d",
        describe: "Run in the background under oxmgr (auto-starts on login)",
        type: "boolean",
        default: false,
      })
      .option("port", {
        describe: "Fixed port for the local VS Code server (default: ephemeral)",
        type: "number",
      }) as any,
  handler: async (argv) => {
    argv.token = argv.token.trim();
    const check = validateToken(argv.token);
    if (!check.ok) {
      console.error(`[codehost] ${check.reason}`);
      console.error(`[codehost] room token requires: ${TOKEN_REQUIREMENTS}`);
      process.exit(1);
    }

    const dir = resolve(process.cwd(), argv.dir);
    const host = hostname();

    // `-d`: re-launch this same `serve` (without -d) under oxmgr, then exit.
    if (argv.daemon) {
      const { ok } = await launchServeDaemon({
        command: "serve",
        dir,
        token: argv.token,
        signal: argv.signal,
        name: argv.name,
        port: argv.port,
        host,
      });
      if (ok) announceConnect(argv.token);
      process.exit(ok ? 0 : 1);
    }

    // A workspace root: repos under it open by GitHub-shaped deep link, mapped
    // onto subfolders via VS Code's ?folder= using this layout. The layout is
    // the same template provisioning uses (.codehost/config.yaml `workspace`),
    // so the advertised list and the provisioned paths agree.
    const layout = readCodehostConfig(dir).workspace || DEFAULT_LAYOUT;
    const plugins = [agentYesPlugin()].filter((p) => p != null);
    const buildMeta = (): PeerMeta =>
      withPluginMeta(
        {
          name: argv.name ?? host,
          // VS Code-web ?folder= form for the browser (C:\ws -> /C:/ws); the
          // real OS path `dir` is still what we spawn VS Code in.
          cwd: toPosixPath(dir),
          host,
          hostId: ensureHostId(),
          kind: "root",
          layout,
          workspaces: enumerateWorkspaces(dir, layout),
        },
        plugins,
      );

    announceConnect(argv.token);
    await runServer({
      token: argv.token,
      signal: argv.signal,
      meta: buildMeta(),
      refreshMeta: buildMeta,
      plugins,
      label: `serving workspace root ${dir}`,
      provision: { homeDir: dir, host: GITHUB_HOST },
      launch: async (basePath) => {
        const v = await launchVscode({ dir, basePath, port: argv.port });
        return { port: v.port, stop: v.stop };
      },
    });
  },
};
