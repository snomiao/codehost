import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDaemonPresence,
  liveDaemon,
  readRegisteredWorkspaces,
  registerWorkspace,
  writeDaemonPresence,
} from "./registry";

const tmp = () => mkdtempSync(join(tmpdir(), "codehost-registry-"));

describe("daemon presence", () => {
  test("round-trips while the pid is alive; cleared file -> null", () => {
    const file = join(tmp(), "daemon.json");
    const p = { pid: process.pid, root: "/Users/x", token: "Str0ng-Token-99", startedAt: 1 };
    writeDaemonPresence(p, file);
    expect(liveDaemon(file)).toEqual(p);
    clearDaemonPresence(file);
    expect(liveDaemon(file)).toBeNull();
  });

  test("a dead pid (stale kill -9 leftover) reads as no daemon", () => {
    const file = join(tmp(), "daemon.json");
    writeDaemonPresence({ pid: 99999999, root: "/x", token: "t0k-En-Stronk", startedAt: 1 }, file);
    expect(liveDaemon(file)).toBeNull();
  });

  test("garbage file reads as no daemon", () => {
    const file = join(tmp(), "daemon.json");
    writeFileSync(file, "not json");
    expect(liveDaemon(file)).toBeNull();
  });
});

describe("workspace registry", () => {
  test("register is idempotent; missing dirs are filtered on read", () => {
    const dir = tmp();
    const file = join(dir, "workspaces.json");
    const ws = join(dir, "proj");
    mkdirSync(ws);
    registerWorkspace(ws, file);
    registerWorkspace(ws, file);
    registerWorkspace(join(dir, "gone"), file); // never created on disk
    const got = readRegisteredWorkspaces(file);
    expect(got).toHaveLength(1);
    expect(got[0].path).toBe(ws);
  });
});
