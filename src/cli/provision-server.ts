import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_YAML, SETUP_PS1, SETUP_SH } from "./init";
import type { LocalRequest } from "./tunnel";
import { repoAllowed, resolveWorkspacePath, validateProvisionTarget, type ProvisionTarget } from "../shared/provision";
import { fromPosixPath, repoKey, toPosixPath } from "../shared/repo";

// Daemon side of provisioning. A repo open hits `GET /__codehost/provision?...`
// over the tunnel; this validates the identity, computes the daemon-authoritative
// workspace path, and (if `.codehost/setup.sh` exists) runs it, streaming its
// output back as the response body. The resolved path rides in the
// `x-codehost-workspace` header so it never depends on parsing script output.

export const PROVISION_PATH = "/__codehost/provision";
const TIMEOUT_MS = Number(process.env.CODEHOST_PROVISION_TIMEOUT_MS) || 15 * 60_000;

export interface ProvisionDeps {
  /** Real OS path of the served home root. */
  homeDir: string;
  /** Git host advertised by this daemon (default github.com). */
  host: string;
  /** Called after a setup script finishes (any exit code) — lets the daemon
   *  re-enumerate + re-advertise its workspaces. */
  onProvisioned?: () => void;
}

export interface CodehostConfig {
  workspace?: string; // layout template, e.g. "ws/{owner}/{repo}/tree/{branch}"
  allowlist?: string[];
}

/** True for the provision route (ignoring the query string). */
export function isProvisionPath(path: string): boolean {
  return path.split("?")[0] === PROVISION_PATH;
}

export function readCodehostConfig(homeDir: string): CodehostConfig {
  try {
    const raw = readFileSync(join(homeDir, ".codehost", "config.yaml"), "utf8");
    const c = (parseYaml(raw) ?? {}) as Record<string, unknown>;
    return {
      workspace: typeof c.workspace === "string" ? c.workspace : undefined,
      allowlist: Array.isArray(c.allowlist)
        ? c.allowlist.filter((x): x is string => typeof x === "string")
        : undefined,
    };
  } catch {
    return {};
  }
}

/** Locate the host's setup script (platform-appropriate), or null if none — in
 *  which case provisioning is a no-op and we just return the path. */
function findSetupScript(homeDir: string): string[] | null {
  const dir = join(homeDir, ".codehost");
  if (process.platform === "win32") {
    const bat = join(dir, "setup.bat");
    if (existsSync(bat)) return ["cmd", "/c", bat];
    const ps1 = join(dir, "setup.ps1");
    if (existsSync(ps1)) return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1];
  }
  const sh = join(dir, "setup.sh");
  if (existsSync(sh)) return ["bash", sh];
  return null;
}

export const PROVISION_CONFIG_PATH = "/__codehost/provision-config";

/** True for the provision-config route (ignoring the query string). */
export function isProvisionConfigPath(path: string): boolean {
  return path.split("?")[0] === PROVISION_CONFIG_PATH;
}

export interface ProvisionConfigDeps {
  /** Real OS path of the served home root. */
  homeDir: string;
  /** Called after a save — lets the daemon re-enumerate + re-advertise (e.g. a
   *  freshly-created `.codehost/` surfaces the "⚙ .codehost" workspace shortcut). */
  onSaved?: () => void;
}

type SetupScriptName = "setup.sh" | "setup.bat" | "setup.ps1";

/** Which setup script name/path applies on this daemon's platform, and whether
 *  it currently exists. Mirrors `findSetupScript`'s priority (Windows:
 *  setup.bat then setup.ps1; else setup.sh) but always returns a target path —
 *  even when nothing exists yet — so the config route has somewhere to write
 *  a newly-created script. When neither Windows script exists, setup.ps1 is
 *  the create-target (scaffoldCodehost always writes both setup.sh/setup.ps1). */
function setupScriptInfo(homeDir: string): { name: SetupScriptName; path: string; exists: boolean } {
  const dir = join(homeDir, ".codehost");
  if (process.platform === "win32") {
    const bat = join(dir, "setup.bat");
    if (existsSync(bat)) return { name: "setup.bat", path: bat, exists: true };
    const ps1 = join(dir, "setup.ps1");
    return { name: "setup.ps1", path: ps1, exists: existsSync(ps1) };
  }
  const sh = join(dir, "setup.sh");
  return { name: "setup.sh", path: sh, exists: existsSync(sh) };
}

function defaultScriptBody(name: SetupScriptName): string {
  return name === "setup.ps1" ? SETUP_PS1 : SETUP_SH; // setup.bat has no scaffold; SETUP_SH is the POSIX default
}

export interface ProvisionConfigGetBody {
  configYaml: string;
  configYamlExists: boolean;
  setupScript: string;
  setupScriptName: SetupScriptName;
  setupScriptExists: boolean;
}

export interface ProvisionConfigPutBody {
  configYaml?: string;
  setupScript?: string;
}

/** Serve `GET/PUT /__codehost/provision-config`: view/edit a host's
 *  `.codehost/config.yaml` and setup script from the web UI's settings page.
 *  A missing file reads back as the default scaffold template (with
 *  `*Exists: false`) so the UI can offer to create it pre-filled. Writable
 *  over the same tunnel a connected client already has full terminal access
 *  through, so this isn't a new privilege boundary — just a structured
 *  shortcut to what the terminal can already do. */
export async function handleProvisionConfig(req: LocalRequest, deps: ProvisionConfigDeps): Promise<Response> {
  if (req.method === "GET") {
    const configPath = join(deps.homeDir, ".codehost", "config.yaml");
    const configYamlExists = existsSync(configPath);
    const configYaml = configYamlExists ? readFileSync(configPath, "utf8") : CONFIG_YAML;
    const info = setupScriptInfo(deps.homeDir);
    const setupScript = info.exists ? readFileSync(info.path, "utf8") : defaultScriptBody(info.name);
    const body: ProvisionConfigGetBody = {
      configYaml,
      configYamlExists,
      setupScript,
      setupScriptName: info.name,
      setupScriptExists: info.exists,
    };
    return json(200, body);
  }
  if (req.method === "PUT") {
    let body: ProvisionConfigPutBody;
    try {
      body = JSON.parse(new TextDecoder().decode(req.body ?? new Uint8Array()));
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const dir = join(deps.homeDir, ".codehost");
    mkdirSync(dir, { recursive: true });
    if (typeof body.configYaml === "string") writeFileSync(join(dir, "config.yaml"), body.configYaml);
    if (typeof body.setupScript === "string") {
      const info = setupScriptInfo(deps.homeDir);
      writeFileSync(info.path, body.setupScript);
      if (info.name === "setup.sh") {
        try {
          chmodSync(info.path, 0o755);
        } catch {
          // non-POSIX fs — ignore
        }
      }
    }
    try {
      deps.onSaved?.();
    } catch {
      // advertising is best-effort; never fail the save response
    }
    return json(200, { ok: true });
  }
  return json(405, { error: "method not allowed" });
}

// Per-workspace coalescing: a concurrent open of the same target waits for the
// running provision instead of spawning a second one.
const inFlight = new Map<string, Promise<number>>();

export async function handleProvision(rawPath: string, deps: ProvisionDeps): Promise<Response> {
  const url = new URL(`http://x${rawPath}`);
  const v = validateProvisionTarget(
    url.searchParams.get("owner") ?? "",
    url.searchParams.get("repo") ?? "",
    url.searchParams.get("branch") ?? "",
  );
  if (!v.ok) return json(400, { error: v.reason });

  const host = (url.searchParams.get("host") ?? deps.host).toLowerCase();
  const cfg = readCodehostConfig(deps.homeDir);
  const key = repoKey({ host, owner: v.target.owner, name: v.target.repo });
  if (!repoAllowed(key, cfg.allowlist)) return json(403, { error: `repo not allowlisted: ${key}` });

  const wsPosix = resolveWorkspacePath(toPosixPath(deps.homeDir), cfg.workspace ?? "", v.target);
  const headers = { "x-codehost-workspace": wsPosix };

  const cmd = findSetupScript(deps.homeDir);
  if (!cmd) return json(200, { workspace: wsPosix }, headers); // no script: hand back the path

  const lockKey = fromPosixPath(wsPosix);
  const existing = inFlight.get(lockKey);
  const body = existing
    ? coalescedBody(existing) // a provision is already running for this workspace
    : freshBody(cmd, deps, v.target, host, lockKey);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Spawn the setup script, streaming merged stdout+stderr, ending with an exit
 *  sentinel the browser parses for success/failure. */
function freshBody(
  cmd: string[],
  deps: ProvisionDeps,
  target: ProvisionTarget,
  host: string,
  lockKey: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let resolveDone!: (code: number) => void;
      inFlight.set(lockKey, new Promise<number>((r) => (resolveDone = r)));
      const say = (s: string) => controller.enqueue(enc.encode(s));
      say(`[codehost] provisioning ${host}/${target.owner}/${target.repo}@${target.branch}\n`);
      let code = 1;
      try {
        const proc = Bun.spawn(cmd, {
          cwd: deps.homeDir,
          env: {
            ...process.env,
            CODEHOST_OWNER: target.owner,
            CODEHOST_REPO: target.repo,
            CODEHOST_BRANCH: target.branch,
            CODEHOST_HOST: host,
            CODEHOST_HOME: deps.homeDir,
            CODEHOST_WS: fromPosixPath(lockKey),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // already gone
          }
        }, TIMEOUT_MS);
        const pump = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        };
        await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
        code = await proc.exited;
        clearTimeout(timer);
      } catch (err) {
        say(`[codehost] provision error: ${String(err)}\n`);
      } finally {
        inFlight.delete(lockKey);
        resolveDone(code);
        say(`\n::codehost:exit=${code}\n`);
        controller.close();
        try {
          deps.onProvisioned?.();
        } catch {
          // advertising is best-effort; never fail the provision response
        }
      }
    },
  });
}

/** Attach to a running provision: wait for it, then emit the exit sentinel. */
function coalescedBody(existing: Promise<number>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode("[codehost] provision already running for this workspace; waiting…\n"));
      const code = await existing.catch(() => 1);
      controller.enqueue(enc.encode(`\n::codehost:exit=${code}\n`));
      controller.close();
    },
  });
}

function json(status: number, obj: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}
