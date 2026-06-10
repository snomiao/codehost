import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toPosixPath } from "../../shared/repo";
import type { AgentInfo } from "../../shared/signaling";
import type { DaemonPlugin } from "./types";

// agent-yes plugin: advertises the machine's live agent CLI sessions (read
// straight from agent-yes's registry, so it works even when `ay serve` is
// down) and proxies /__codehost/agent-yes/* to the local `ay serve` API with
// its bearer token injected. Granting room members agent control is not new
// trust: the room token already grants code execution (the editor is a
// terminal) — same boundary as provisioning (see shared/provision.ts).

const AY_DIR = join(homedir(), ".agent-yes");
const AY_PORT = Number(process.env.CODEHOST_AY_PORT) || 7432;
/** Cap the advertised list (meta rides the signaling room broadcast). */
const MAX_AGENTS = 50;

interface AyRecord {
  pid: number;
  cli?: string;
  prompt?: string | null;
  cwd?: string;
  status?: "active" | "idle" | "exited";
  started_at?: number;
}

/** agent-yes's global registry: JSONL, last line per pid wins. */
export function readAgents(dir: string = AY_DIR): AgentInfo[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "pids.jsonl"), "utf8");
  } catch {
    return [];
  }
  const byPid = new Map<number, AyRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as AyRecord;
      if (typeof rec.pid === "number") byPid.set(rec.pid, { ...byPid.get(rec.pid), ...rec });
    } catch {
      // skip malformed lines
    }
  }
  const out: AgentInfo[] = [];
  for (const rec of [...byPid.values()].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))) {
    if (out.length >= MAX_AGENTS) break;
    if (rec.status === "exited" || !alive(rec.pid)) continue;
    out.push({
      pid: rec.pid,
      tool: rec.cli || "agent",
      ...(rec.prompt ? { title: rec.prompt.slice(0, 120) } : {}),
      cwd: toPosixPath(rec.cwd ?? ""),
      state: rec.status === "active" ? "active" : "idle",
      ...(rec.started_at ? { startedAt: rec.started_at } : {}),
    });
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serveToken(dir: string): string | null {
  try {
    const t = readFileSync(join(dir, ".serve-token"), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** The plugin, or null when this machine has never run agent-yes. */
export function agentYesPlugin(dir: string = AY_DIR): DaemonPlugin | null {
  if (!existsSync(dir)) return null;
  return {
    name: "agent-yes",
    meta: () => {
      const agents = readAgents(dir);
      return agents.length > 0 ? { agents } : {};
    },
    route: async (path, req) => {
      const token = serveToken(dir);
      if (!token) {
        return new Response(JSON.stringify({ error: "ay serve has no token (is agent-yes installed?)" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const headers = new Headers(req.headers);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("host", `127.0.0.1:${AY_PORT}`);
      try {
        return await fetch(`http://127.0.0.1:${AY_PORT}${path}`, {
          method: req.method,
          headers,
          body: req.body as BodyInit | undefined,
          redirect: "manual",
        });
      } catch {
        return new Response(JSON.stringify({ error: "ay serve is not running (start it with `ay serve install`)" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    },
  };
}
