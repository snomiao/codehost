import { hostname } from "node:os";
import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { type PeerMeta, newPeerId } from "../../shared/signaling";
import { SignalingClient } from "../../shared/signaling-client";
import { RtcDaemon } from "../rtc-daemon";
import { launchVscode } from "../vscode";
import { Tunnel } from "../tunnel";
import { daemonName, startDaemon } from "../oxmgr";

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
  describe: "Serve VS Code from a directory and peer it to codehost.dev over WebRTC",
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
        describe: "Run in the background under oxmgr",
        type: "boolean",
        default: false,
      })
      .option("port", {
        describe: "Fixed port for the local VS Code server (default: ephemeral)",
        type: "number",
      }) as any,
  handler: async (argv) => {
    const dir = resolve(process.cwd(), argv.dir);
    const host = hostname();
    const meta: PeerMeta = {
      name: argv.name ?? host,
      cwd: dir,
      host,
    };

    // `-d`: re-launch this same `serve` (without -d) under oxmgr, then exit.
    if (argv.daemon) {
      const label = argv.name ?? dir.split("/").pop() ?? host;
      const name = daemonName(label);
      const command = buildForegroundCommand(dir, argv);
      console.log(`[codehost] starting daemon "${name}" via oxmgr`);
      const ok = startDaemon({ name, command, cwd: dir });
      if (ok) {
        console.log(`[codehost] daemon started. View: codehost list · Stop: codehost stop ${name}`);
        process.exit(0);
      }
      process.exit(1);
    }

    // peerId is fixed up front so VS Code can be mounted under /vs/<peerId>,
    // which the browser Service Worker uses to route requests to this daemon.
    const peerId = newPeerId();
    const basePath = `/vs/${peerId}`;

    console.log(`[codehost] serving ${dir}`);
    console.log(`[codehost] room token: ${argv.token}`);
    console.log(`[codehost] signaling:  ${argv.signal}`);

    const vscode = await launchVscode({ dir, basePath, port: argv.port });

    let rtc: RtcDaemon;

    const client = new SignalingClient({
      url: argv.signal,
      token: argv.token,
      role: "server",
      peerId,
      meta,
      onOpen: () => console.log(`[codehost] registered as "${meta.name}" (${peerId.slice(0, 8)})`),
      onClose: () => console.log("[codehost] disconnected from signaling, reconnecting…"),
      onSignal: (from, data) => rtc.handleSignal(from, data),
    });

    rtc = new RtcDaemon({
      sendSignal: (to, data) => client.sendSignal(to, data),
      // Each viewer's data channel is bridged to the local VS Code server.
      onChannel: (viewerId, channel) => {
        console.log(`[codehost] viewer ${viewerId.slice(0, 8)} connected; bridging to VS Code`);
        new Tunnel(channel, vscode.port);
      },
    });

    client.connect();

    const shutdown = () => {
      console.log("\n[codehost] shutting down");
      rtc.closeAll();
      client.close();
      vscode.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep the process alive.
    await new Promise<never>(() => {});
  },
};

/**
 * Reconstruct the exact foreground `serve` invocation (without -d) for oxmgr to
 * run. Uses the same runtime + entry script that launched us, so it works both
 * for `bunx codehost` and local `bun src/cli/index.ts`.
 */
function buildForegroundCommand(dir: string, argv: ServeArgs): string {
  const parts = [process.execPath, process.argv[1], "serve", dir, "-t", argv.token, "--signal", argv.signal];
  if (argv.name) parts.push("--name", argv.name);
  if (argv.port) parts.push("--port", String(argv.port));
  return parts.map(quote).join(" ");
}

function quote(s: string): string {
  return /[^A-Za-z0-9_\/:=.-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}
