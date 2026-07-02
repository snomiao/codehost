import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_YAML, SETUP_PS1, SETUP_SH } from "./init";
import type { LocalRequest } from "./tunnel";
import { repoAllowed, resolveWorkspacePath, validateProvisionTarget } from "../shared/provision";
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
  /** Room token — never passed to the script, only used to redact it out of
   *  the streamed log if the script happens to echo it. */
  token?: string;
  /** Called after a setup script finishes (any exit code) — lets the daemon
   *  re-enumerate + re-advertise its workspaces. */
  onProvisioned?: () => void;
}

export interface CodehostConfig {
  workspace?: string; // layout template, e.g. "ws/{owner}/{repo}/tree/{branch}"
  allowlist?: string[];
  /** Opt-in: also run the provisioning hook (setup.sh) before opening a
   *  `/host/<hostname>/<path>` folder-mount link, not just repo links. Off by
   *  default — a folder-mount link means "open this already-served path"
   *  today, and running a hook there is new behavior. */
  folderProvisioning?: boolean;
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
      folderProvisioning: c.folderProvisioning === true,
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
  /** The built-in starter template, always included (even when a real config
   *  already exists) so the UI can offer a "reset to default" action. */
  configYamlDefault: string;
  setupScript: string;
  setupScriptName: SetupScriptName;
  setupScriptExists: boolean;
  /** The built-in starter script for this platform, same purpose as
   *  `configYamlDefault`. */
  setupScriptDefault: string;
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
      configYamlDefault: CONFIG_YAML,
      setupScript,
      setupScriptName: info.name,
      setupScriptExists: info.exists,
      setupScriptDefault: defaultScriptBody(info.name),
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
  if (url.searchParams.get("kind") === "folder") return handleFolderProvision(url, deps);

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
    : runScriptBody(
        cmd,
        deps,
        {
          CODEHOST_OWNER: v.target.owner,
          CODEHOST_REPO: v.target.repo,
          CODEHOST_BRANCH: v.target.branch,
          CODEHOST_HOST: host,
          CODEHOST_HOME: deps.homeDir,
          CODEHOST_WS: fromPosixPath(wsPosix),
          CODEHOST_TARGET_KIND: "repo",
          CODEHOST_REPO_KEY: key,
        },
        `[codehost] provisioning ${host}/${v.target.owner}/${v.target.repo}@${v.target.branch}\n`,
        lockKey,
      );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Folder-mount provisioning (`?kind=folder&path=...`): opt-in per
 *  `config.yaml`'s `folderProvisioning`. Unlike repo provisioning, the path
 *  is already known (resolved client-side against an existing served
 *  workspace) — this just gives it the same pre-open hook opportunity a repo
 *  open gets, e.g. for a `git pull` or dependency install before editing. */
async function handleFolderProvision(url: URL, deps: ProvisionDeps): Promise<Response> {
  const cfg = readCodehostConfig(deps.homeDir);
  if (!cfg.folderProvisioning) {
    return json(403, { error: "folder provisioning is disabled (set folderProvisioning: true in config.yaml)" });
  }
  const rawPath = url.searchParams.get("path") ?? "";
  if (!rawPath) return json(400, { error: "missing path" });
  const wsPosix = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const headers = { "x-codehost-workspace": wsPosix };

  const cmd = findSetupScript(deps.homeDir);
  if (!cmd) return json(200, { workspace: wsPosix }, headers); // no script: hand back the path

  const lockKey = fromPosixPath(wsPosix);
  const existing = inFlight.get(lockKey);
  const body = existing
    ? coalescedBody(existing)
    : runScriptBody(
        cmd,
        deps,
        {
          CODEHOST_HOME: deps.homeDir,
          CODEHOST_WS: fromPosixPath(wsPosix),
          CODEHOST_TARGET_KIND: "folder",
          CODEHOST_TARGET_PATH: fromPosixPath(wsPosix),
        },
        `[codehost] provisioning ${wsPosix}\n`,
        lockKey,
      );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// Env var names whose values look secret-ish enough to redact out of the
// streamed provisioning log (best-effort — see collectSecrets doc).
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH/i;
const MIN_SECRET_LEN = 6; // shorter values redact too eagerly (false positives on common substrings)

/** Values to scrub from the streamed provisioning log before it reaches the
 *  browser: the room token, plus every value of this process's own env vars
 *  whose *name* looks secret-shaped (the exact set `Bun.spawn` inherits into
 *  the child, so it's exactly what a script COULD echo, deliberately or via
 *  `set -x`). This is a best-effort heuristic, not exhaustive redaction — an
 *  arbitrary shell script's stdout can't be fully sanitized in general. */
function collectSecrets(token: string | undefined): string[] {
  const vals = new Set<string>();
  if (token && token.length >= MIN_SECRET_LEN) vals.add(token);
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= MIN_SECRET_LEN && SECRET_ENV_NAME.test(k)) vals.add(v);
  }
  return [...vals].sort((a, b) => b.length - a.length); // longest first, so a substring never masks its own superstring
}

const URL_CREDENTIAL_RE = /(https?:\/\/)[^/\s:@]+(:[^/\s@]*)?@/g;

/** Redact known secret values (exact-match) plus `user:pass@`/`token@` URL
 *  credential forms. Not a general secret scanner — only catches values we
 *  already know to look for. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out.replace(URL_CREDENTIAL_RE, "$1[redacted]@");
}

/** Spawn the setup script, streaming merged stdout+stderr (secrets redacted,
 *  line-buffered), ending with an exit sentinel the browser parses for
 *  success/failure. The script may also emit `::codehost:ready={"path":...}`
 *  on its own line at any point to signal the workspace is usable before it
 *  exits — the browser watches for this and can open the editor early. Shared
 *  by both repo and folder provisioning; `env` carries the mode-specific
 *  `CODEHOST_*` vars. */
function runScriptBody(
  cmd: string[],
  deps: ProvisionDeps,
  env: Record<string, string>,
  announce: string,
  lockKey: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const secrets = collectSecrets(deps.token);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let resolveDone!: (code: number) => void;
      inFlight.set(lockKey, new Promise<number>((r) => (resolveDone = r)));
      const say = (s: string) => controller.enqueue(enc.encode(s));
      say(announce);
      let code = 1;
      try {
        const proc = Bun.spawn(cmd, {
          cwd: deps.homeDir,
          env: { ...process.env, ...env },
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
        // Line-buffer each stream independently (stdout/stderr interleave
        // freely, but a redacted secret must never straddle a chunk boundary
        // within its own stream) and redact before enqueueing.
        const pump = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          const dec = new TextDecoder();
          let pending = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += dec.decode(value, { stream: true });
            const lastNl = pending.lastIndexOf("\n");
            if (lastNl === -1) continue;
            const complete = pending.slice(0, lastNl + 1);
            pending = pending.slice(lastNl + 1);
            controller.enqueue(enc.encode(redact(complete, secrets)));
          }
          pending += dec.decode();
          if (pending) controller.enqueue(enc.encode(redact(pending, secrets)));
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
