import { hostname } from "node:os";
import type { CommandModule } from "yargs";
import type { PeerMeta } from "../../shared/signaling";
import { TOKEN_REQUIREMENTS, validateToken } from "../../shared/token";
import { currentUser, ensureHostId } from "../config";
import { launchServeDaemon } from "../daemonize";
import { runServer } from "../run-server";
import { DEFAULT_SIGNAL_URL } from "./serve";

interface ExposeArgs {
  port: number;
  token: string;
  name?: string;
  signal: string;
  daemon: boolean;
}

export const exposeCommand: CommandModule<{}, ExposeArgs> = {
  command: "expose <port>",
  describe:
    "Tunnel an existing local HTTP/WS server (any port) over WebRTC — reachable at codehost.dev/vs/<peerId>/",
  builder: (y) =>
    y
      .positional("port", {
        describe: "Local port to expose (e.g. 7432)",
        type: "number",
        demandOption: true,
      })
      .option("token", {
        alias: "t",
        describe: "Room token shared with the codehost.dev page",
        type: "string",
        demandOption: true,
      })
      .option("name", {
        describe: "Display name for this server (defaults to localhost:<port>)",
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
      }) as any,
  handler: async (argv) => {
    argv.token = argv.token.trim();
    const check = validateToken(argv.token);
    if (!check.ok) {
      console.error(`[codehost] ${check.reason}`);
      console.error(`[codehost] room token requires: ${TOKEN_REQUIREMENTS}`);
      process.exit(1);
    }
    if (!Number.isInteger(argv.port) || argv.port <= 0 || argv.port > 65535) {
      console.error(`[codehost] invalid port: ${argv.port}`);
      process.exit(1);
    }

    const host = hostname();

    if (argv.daemon) {
      const { ok } = await launchServeDaemon({
        command: "expose",
        dir: process.cwd(),
        arg: String(argv.port),
        token: argv.token,
        signal: argv.signal,
        name: argv.name,
        host,
      });
      process.exit(ok ? 0 : 1);
    }

    const meta: PeerMeta = {
      name: argv.name ?? `localhost:${argv.port}`,
      cwd: `localhost:${argv.port}`,
      host,
      user: currentUser(),
      hostId: ensureHostId(),
    };

    // No VS Code: tunnel directly to the given port, stripping the /vs/<peerId>
    // prefix the server doesn't know about.
    await runServer({
      token: argv.token,
      signal: argv.signal,
      meta,
      label: `exposing localhost:${argv.port}`,
      launch: async (basePath) => ({ port: argv.port, stripBasePath: basePath }),
    });
  },
};
