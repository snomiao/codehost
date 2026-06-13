import { existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type { CommandModule } from "yargs";
import type { PeerMeta } from "../../shared/signaling";
import type { ApprovePolicy } from "../approver";
import { DEFAULT_LAYOUT, GITHUB_HOST, toPosixPath } from "../../shared/repo";
import { TOKEN_REQUIREMENTS, validateToken } from "../../shared/token";
import { defaultRoot, ensureHostId } from "../config";
import { launchServeDaemon } from "../daemonize";
import { announceConnect } from "../open-url";
import { agentYesPlugin } from "../plugins/agent-yes";
import { withPluginMeta } from "../plugins/types";
import { readCodehostConfig } from "../provision-server";
import {
  clearDaemonPresence,
  readRegisteredWorkspaces,
  workspacesFile,
  writeDaemonPresence,
} from "../registry";
import { repoIdentity } from "../git";
import { runServer } from "../run-server";
import { launchVscode } from "../vscode";
import { enumerateWorkspaces } from "../workspaces";

export const DEFAULT_SIGNAL_URL = "wss://signal.codehost.dev";

/** Warn + interactively confirm a risky root (default No). Non-TTY contexts
 *  (the oxmgr-daemonized child, CI) can't answer — there the human already
 *  confirmed at launch time, so warn loudly and proceed. */
export async function confirmRiskyRoot(dir: string): Promise<boolean> {
  const warning = rootWarning(dir);
  if (!warning) return true;
  console.warn(`[codehost] warning: ${warning}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  process.stdout.write("[codehost] serve it anyway? [y/N] ");
  const line = await new Promise<string>((res) => {
    process.stdin.resume();
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      res(String(d));
    });
  });
  return /^y(es)?$/i.test(line.trim());
}

/** Warning for serving a risky workspace root, or null if fine. $HOME (and the
 *  filesystem root) expose everything you own over the room, collide the
 *  provisioning `.codehost/` with the machine-level `~/.codehost`, and make
 *  workspace enumeration walk your whole home. Allowed if you insist — but
 *  say so loudly and point at a dedicated dir like ~/ws. */
export function rootWarning(dir: string): string | null {
  const norm = resolve(dir);
  if (norm === resolve(homedir())) {
    return "serving your HOME directory as the workspace root — everything in it is reachable through this room. A dedicated dir is safer: codehost serve ~/ws";
  }
  if (norm === resolve("/")) {
    return "serving the filesystem root — the entire machine is reachable through this room. A dedicated dir is safer, e.g. ~/ws";
  }
  return null;
}

interface ServeArgs {
  dir?: string;
  token: string;
  name?: string;
  signal: string;
  daemon: boolean;
  port?: number;
  approve: string;
  allow: string[];
}

export const serveCommand: CommandModule<{}, ServeArgs> = {
  command: "serve [dir]",
  describe:
    "Serve a workspace root over WebRTC; repos under it open via codehost.dev/gh/<owner>/<repo> (or /git/<host>/<owner>/<repo>)",
  builder: (y) =>
    y
      .positional("dir", {
        describe: "Workspace root to serve (default: the remembered root, else ~/ws)",
        type: "string",
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

    // Explicit dir > remembered root (config.json) > ~/ws. Bare `codehost
    // serve` should land somewhere sane, never accidentally on $HOME/cwd.
    const dir = argv.dir ? resolve(process.cwd(), argv.dir) : defaultRoot();
    if (!argv.dir) {
      mkdirSync(dir, { recursive: true });
      console.log(`[codehost] no dir given — serving workspace root ${dir}`);
    }
    if (!(await confirmRiskyRoot(dir))) {
      console.error("[codehost] aborted");
      process.exit(1);
    }
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
        approve: argv.approve,
        allow: argv.allow,
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
    // buildMeta runs every AGENTS_META_POLL_MS so live agent titles propagate
    // (the room only sees a push when something changed). The filesystem walk
    // for checkouts is the expensive part — memoize it; registered workspaces
    // and agents are cheap reads and stay fresh on every call.
    const WORKSPACE_WALK_TTL_MS = 30_000;
    let wsWalk: { at: number; list: ReturnType<typeof enumerateWorkspaces> } | null = null;
    const buildMeta = (): PeerMeta => {
      // Layout-enumerated checkouts plus directories other `codehost dev` runs
      // registered with this host daemon (git-identified best-effort).
      if (!wsWalk || Date.now() - wsWalk.at > WORKSPACE_WALK_TTL_MS) {
        const list = enumerateWorkspaces(dir, layout);
        // The config dir itself is editable from the site (rendered as ⚙, opens
        // in the editor) — advertised so its /host/<host>/<path> link resolves.
        const configDir = join(dir, ".codehost");
        if (existsSync(configDir)) {
          list.push({ path: toPosixPath(configDir), config: true });
        }
        wsWalk = { at: Date.now(), list };
      }
      const workspaces = [...wsWalk.list];
      for (const w of readRegisteredWorkspaces()) {
        const path = toPosixPath(w.path);
        if (workspaces.some((x) => x.path === path)) continue;
        const id = repoIdentity(w.path);
        workspaces.push({
          path,
          ...(id.repo ? { repo: id.repo } : {}),
          ...(id.branch ? { branch: id.branch } : {}),
        });
      }
      return withPluginMeta(
        {
          name: argv.name ?? host,
          // VS Code-web ?folder= form for the browser (C:\ws -> /C:/ws); the
          // real OS path `dir` is still what we spawn VS Code in.
          cwd: toPosixPath(dir),
          host,
          hostId: ensureHostId(),
          kind: "root",
          layout,
          workspaces,
        },
        plugins,
      );
    };

    // Mark this process as the host daemon, so later `codehost dev` runs
    // register their directory with it instead of spawning a second peer.
    writeDaemonPresence({ pid: process.pid, root: dir, token: argv.token, startedAt: Date.now() });
    process.on("exit", () => clearDaemonPresence());

    announceConnect(argv.token);
    await runServer({
      token: argv.token,
      signal: argv.signal,
      meta: buildMeta(),
      refreshMeta: buildMeta,
      // Fast poll so agents' self-set titles go live on the site sidepanel;
      // per tick it's pid-liveness checks + log-tail stat()s (see liveTitle).
      metaRefreshMs: 3_000,
      watchFiles: [workspacesFile()],
      plugins,
      approve: argv.approve as ApprovePolicy,
      allow: argv.allow,
      label: `serving workspace root ${dir}`,
      provision: { homeDir: dir, host: GITHUB_HOST },
      launch: async (basePath) => {
        const v = await launchVscode({ dir, basePath, port: argv.port });
        return { port: v.port, stop: v.stop };
      },
    });
  },
};
