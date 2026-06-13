import { hostname } from "node:os";
import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import type { PeerMeta } from "../../shared/signaling";
import type { ApprovePolicy } from "../approver";
import { TOKEN_REQUIREMENTS, validateToken } from "../../shared/token";
import { ensureHostId } from "../config";
import { launchServeDaemon } from "../daemonize";
import { announceConnect } from "../open-url";
import { runServer } from "../run-server";
import { launchVscode } from "../vscode";
import { repoIdentity } from "../git";
import { liveDaemon, registerWorkspace } from "../registry";
import { shareableDeepLink, toPosixPath } from "../../shared/repo";
import { DEFAULT_SIGNAL_URL } from "./serve";

interface DevArgs {
  dir: string;
  token: string;
  name?: string;
  signal: string;
  daemon: boolean;
  standalone: boolean;
  port?: number;
  approve: string;
  allow: string[];
}

export const devCommand: CommandModule<{}, DevArgs> = {
  command: "dev [dir]",
  describe:
    "Serve a single folder over WebRTC; open it at codehost.dev/host/<hostname>/<path> (or /gh/<owner>/<repo>, /git/<host>/<owner>/<repo> for a git repo)",
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
      .option("standalone", {
        describe: "Always spawn an own peer + VS Code, even when a host daemon already runs",
        type: "boolean",
        default: false,
      })
      .option("port", {
        describe: "Fixed port for the local VS Code server (default: ephemeral)",
        type: "number",
      })
      .option("approve", {
        describe: "Client admission: 'auto' (anyone with the token) or 'confirm' (approve each at the terminal)",
        type: "string",
        choices: ["auto", "confirm"],
        default: "auto",
      })
      .option("allow", {
        describe: "Under --approve confirm, auto-approve clients whose label matches (repeatable)",
        type: "string",
        array: true,
        default: [],
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

    // One daemon per host: a single VS Code serve-web opens any local path via
    // ?folder=, so when a root daemon already runs here, just REGISTER this
    // directory with it (it re-advertises within moments) instead of spawning a
    // second peer + VS Code. --standalone restores the old behavior.
    const daemon = argv.standalone ? null : liveDaemon();
    if (daemon) {
      registerWorkspace(dir);
      const id = repoIdentity(dir);
      const path =
        (id.repo
          ? shareableDeepLink({ repo: id.repo, branch: id.branch })
          : shareableDeepLink({ folder: toPosixPath(dir), host })) ?? "/";
      console.log(`[codehost] host daemon already serving "${daemon.root}" (pid ${daemon.pid})`);
      console.log(`[codehost] registered ${dir} with it — no second daemon needed`);
      console.log(`[codehost] open: https://codehost.dev${path}#t=${encodeURIComponent(daemon.token)}`);
      if (daemon.token !== argv.token) {
        console.log("[codehost] note: the host daemon's room differs from your -t; the link above uses the daemon's room");
      }
      console.log("[codehost] (use --standalone to force an own daemon instead)");
      return;
    }

    if (argv.daemon) {
      const { ok } = await launchServeDaemon({
        command: "dev",
        dir,
        token: argv.token,
        signal: argv.signal,
        name: argv.name,
        port: argv.port,
        host,
        approve: argv.approve,
        allow: argv.allow,
      });
      if (ok) announceConnect(argv.token);
      process.exit(ok ? 0 : 1);
    }

    // A single folder: git-identified so GitHub deep links resolve to it.
    const id = repoIdentity(dir);
    const meta: PeerMeta = {
      name: argv.name ?? host,
      // VS Code-web ?folder= form for the browser (C:\ws -> /C:/ws); `dir` stays
      // the real OS path for the local VS Code working dir.
      cwd: toPosixPath(dir),
      host,
      hostId: ensureHostId(),
      kind: "repo",
      repo: id.repo,
      branch: id.branch,
    };

    announceConnect(argv.token);
    await runServer({
      token: argv.token,
      signal: argv.signal,
      meta,
      label: `serving ${dir}`,
      approve: argv.approve as ApprovePolicy,
      allow: argv.allow,
      launch: async (basePath) => {
        const v = await launchVscode({ dir, basePath, port: argv.port });
        return { port: v.port, stop: v.stop };
      },
    });
  },
};
