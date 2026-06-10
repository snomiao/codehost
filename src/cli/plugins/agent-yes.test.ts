import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentYesPlugin, readAgents } from "./agent-yes";
import { routePlugins, withPluginMeta } from "./types";

function makeAyDir(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codehost-ay-"));
  writeFileSync(join(dir, "pids.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

describe("readAgents", () => {
  test("last line per pid wins; exited and dead pids are dropped", () => {
    const dir = makeAyDir([
      { pid: process.pid, cli: "claude", prompt: "fix the bug", cwd: "/tmp", status: "idle", started_at: 5 },
      { pid: 99999999, cli: "gemini", cwd: "/tmp", status: "active" }, // dead pid
      { pid: process.pid, cli: "claude", status: "exited", exit_code: 0 }, // last line per pid wins
    ]);
    // The final line marks our (live) pid exited, and the other pid is dead.
    expect(readAgents(dir)).toHaveLength(0);
  });

  test("maps a live record to AgentInfo", () => {
    const dir = makeAyDir([
      { pid: process.pid, cli: "claude", prompt: "do things", cwd: "/tmp/x", status: "active", started_at: 7 },
    ]);
    expect(readAgents(dir)).toEqual([
      { pid: process.pid, tool: "claude", title: "do things", cwd: "/tmp/x", state: "active", startedAt: 7 },
    ]);
  });

  test("missing registry -> empty", () => {
    expect(readAgents(mkdtempSync(join(tmpdir(), "codehost-ay-empty-")))).toEqual([]);
  });
});

describe("plugin routing + meta", () => {
  test("routePlugins dispatches under /__codehost/<name>/ with the sub-path", async () => {
    const seen: string[] = [];
    const plugin = {
      name: "agent-yes",
      route: async (path: string) => {
        seen.push(path);
        return new Response("ok");
      },
    };
    const res = routePlugins([plugin], {
      method: "GET",
      path: "/__codehost/agent-yes/api/ls?active=1",
      headers: new Headers(),
    });
    expect(res).not.toBeNull();
    await res;
    expect(seen).toEqual(["/api/ls?active=1"]);
    expect(
      routePlugins([plugin], { method: "GET", path: "/__codehost/other/x", headers: new Headers() }),
    ).toBeNull();
  });

  test("withPluginMeta merges contributions over the base", () => {
    const base = { name: "x", cwd: "/", host: "mac" };
    const merged = withPluginMeta(base, [{ name: "agent-yes", meta: () => ({ agents: [] }) }]);
    expect(merged).toEqual({ name: "x", cwd: "/", host: "mac", agents: [] });
  });

  test("agentYesPlugin returns null when the dir doesn't exist", () => {
    expect(agentYesPlugin("/nonexistent/definitely-not-here")).toBeNull();
  });
});
