import { spawn, type Subprocess } from "bun";

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
  const args = [
    "serve-web",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--server-base-path",
    opts.basePath,
    "--default-folder",
    opts.dir,
    "--without-connection-token",
    "--accept-server-license-terms",
  ];

  console.log(`[codehost] launching: code ${args.join(" ")}`);
  const proc = spawn(["code", ...args], {
    cwd: opts.dir,
    stdout: "inherit",
    stderr: "inherit",
  });

  const base = `http://127.0.0.1:${port}${opts.basePath}/`;
  await waitForHttp(base, 30_000);
  console.log(`[codehost] VS Code ready at ${base}`);

  const stop = () => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };
  return { port, basePath: opts.basePath, proc, stop };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(300);
  }
  throw new Error(`VS Code did not become ready at ${url} within ${timeoutMs}ms`);
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
