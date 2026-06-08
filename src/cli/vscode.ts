import { spawn, type Subprocess } from "bun";
import { resolveCodeBinary } from "./vscode-install";
import { killProcessTree } from "./proc";

// How long to wait for `code serve-web` to answer. The default is generous
// because the FIRST run downloads the server component, which can take minutes
// on a slow link or a fresh Windows box — and under the oxmgr daemon
// (`--restart on-failure`) a too-short timeout makes us exit mid-download, get
// restarted, and re-download forever. Override with CODEHOST_VSCODE_READY_TIMEOUT_MS.
const READY_TIMEOUT_MS = Number(process.env.CODEHOST_VSCODE_READY_TIMEOUT_MS) || 10 * 60_000;

export interface VscodeServer {
  port: number;
  basePath: string;
  proc: Subprocess;
  stop: () => void;
}

export interface LaunchOptions {
  /** Folder to open in VS Code. */
  dir: string;
  /** Base path the server is mounted under, e.g. /vs/<peerId>. */
  basePath: string;
  /** Fixed port, or 0 to let VS Code pick a free one. */
  port?: number;
}

/**
 * Launch `code serve-web` for a directory under a given base path and wait
 * until it answers. Mirrors the prior project's flag set
 * (tmp/.../vscode-server.cjs): no connection token, license accepted.
 */
export async function launchVscode(opts: LaunchOptions): Promise<VscodeServer> {
  const port = opts.port && opts.port > 0 ? opts.port : await freePort();
  // NB: no `--default-folder` — current VS Code `serve-web` (≥1.x) doesn't
  // accept it and exits with "unexpected argument". The workspace is opened by
  // the browser instead, via the `?folder=` query the page appends to the
  // iframe URL (see src/web/discovery.tsx). `cwd` below still roots the server.
  const args = [
    "serve-web",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--server-base-path",
    opts.basePath,
    "--without-connection-token",
    "--accept-server-license-terms",
  ];

  const codeBin = await resolveCodeBinary();
  console.log(`[codehost] launching: ${codeBin} ${args.join(" ")}`);
  const proc = spawn([codeBin, ...args], {
    cwd: opts.dir,
    stdout: "inherit",
    stderr: "inherit",
  });

  const base = `http://127.0.0.1:${port}${opts.basePath}/`;
  await waitForHttp(base, READY_TIMEOUT_MS, proc);
  console.log(`[codehost] VS Code ready at ${base}`);

  const stop = () => {
    try {
      // serve-web double-forks; kill the whole tree so the real VS Code server
      // doesn't linger as an orphan after the daemon stops.
      if (proc.pid) killProcessTree(proc.pid);
      else proc.kill();
    } catch {
      // ignore
    }
  };
  return { port, basePath: opts.basePath, proc, stop };
}

async function waitForHttp(url: string, timeoutMs: number, proc?: Subprocess): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let nextHeartbeat = started + 15_000;
  while (Date.now() < deadline) {
    // If the server process died (bad flag, crash), fail now instead of waiting
    // out the whole timeout — and surface that it exited rather than hung.
    if (proc && proc.exitCode !== null) {
      throw new Error(`VS Code server exited (code ${proc.exitCode}) before becoming ready at ${url}`);
    }
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= nextHeartbeat) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(`[codehost] waiting for VS Code server to start… (${secs}s; first run downloads the server component)`);
      nextHeartbeat += 15_000;
    }
    await Bun.sleep(300);
  }
  throw new Error(
    `VS Code did not become ready at ${url} within ${timeoutMs}ms ` +
      `(first-run server download can be slow — raise CODEHOST_VSCODE_READY_TIMEOUT_MS)`,
  );
}

async function freePort(): Promise<number> {
  // Bind to port 0 to get an OS-assigned free port, then release it.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}
