import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleProvision, isProvisionPath } from "./provision-server";

// A throwaway home with an optional .codehost/setup.sh.
function makeHome(setup?: string, configYaml?: string): string {
  const home = mkdtempSync(join(tmpdir(), "codehost-prov-"));
  if (setup || configYaml) mkdirSync(join(home, ".codehost"), { recursive: true });
  if (setup) writeFileSync(join(home, ".codehost", "setup.sh"), setup);
  if (configYaml) writeFileSync(join(home, ".codehost", "config.yaml"), configYaml);
  homes.push(home);
  return home;
}
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const q = (owner: string, repo: string, branch = "main") =>
  `/__codehost/provision?owner=${owner}&repo=${repo}&branch=${branch}`;

describe("isProvisionPath", () => {
  test("matches the route, ignores query + other paths", () => {
    expect(isProvisionPath("/__codehost/provision?owner=a")).toBe(true);
    expect(isProvisionPath("/vs/abc/?folder=x")).toBe(false);
  });
});

describe("handleProvision", () => {
  test("no setup script → 200 + workspace path in header/body (today's behavior)", async () => {
    const home = makeHome();
    const res = await handleProvision(q("snomiao", "codehost"), { homeDir: home, host: "github.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-codehost-workspace")).toBe(`${home}/snomiao/codehost/tree/main`);
    expect(await res.json()).toEqual({ workspace: `${home}/snomiao/codehost/tree/main` });
  });

  test("runs setup.sh, streams output + exit sentinel, env is passed", async () => {
    const home = makeHome('echo "owner=$CODEHOST_OWNER branch=$CODEHOST_BRANCH ws=$CODEHOST_WS"\nexit 0\n');
    const res = await handleProvision(q("snomiao", "codehost", "feat/x"), { homeDir: home, host: "github.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-codehost-workspace")).toBe(`${home}/snomiao/codehost/tree/feat/x`);
    const body = await res.text();
    expect(body).toContain(`owner=snomiao branch=feat/x ws=${home}/snomiao/codehost/tree/feat/x`);
    expect(body).toContain("::codehost:exit=0");
  });

  test("propagates a non-zero exit code in the sentinel", async () => {
    const home = makeHome('echo "boom" >&2\nexit 7\n');
    const res = await handleProvision(q("snomiao", "codehost"), { homeDir: home, host: "github.com" });
    const body = await res.text();
    expect(body).toContain("boom");
    expect(body).toContain("::codehost:exit=7");
  });

  test("rejects a traversal identity with 400 (no spawn)", async () => {
    const home = makeHome("echo SHOULD_NOT_RUN\nexit 0\n");
    const res = await handleProvision(q("..", "codehost"), { homeDir: home, host: "github.com" });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("SHOULD_NOT_RUN");
  });

  test("enforces the config allowlist with 403", async () => {
    const home = makeHome("echo hi\nexit 0\n", "allowlist:\n  - github.com/snomiao/*\n");
    const ok = await handleProvision(q("snomiao", "codehost"), { homeDir: home, host: "github.com" });
    expect(ok.status).toBe(200);
    const denied = await handleProvision(q("evil", "repo"), { homeDir: home, host: "github.com" });
    expect(denied.status).toBe(403);
  });

  test("config.yaml workspace template overrides the layout", async () => {
    const home = makeHome(undefined, 'workspace: "ws/{owner}/{repo}/tree/{branch}"\n');
    const res = await handleProvision(q("snomiao", "codehost"), { homeDir: home, host: "github.com" });
    expect(res.headers.get("x-codehost-workspace")).toBe(`${home}/ws/snomiao/codehost/tree/main`);
  });
});
