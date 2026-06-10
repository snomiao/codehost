import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { scaffoldCodehost } from "./init";

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
function mkHome(): string {
  const h = mkdtempSync(join(tmpdir(), "codehost-init-"));
  homes.push(h);
  return h;
}

describe("scaffoldCodehost", () => {
  test("writes config.yaml + setup.sh + setup.ps1", () => {
    const home = mkHome();
    const written = scaffoldCodehost(home);
    expect(written).toHaveLength(3);
    expect(existsSync(join(home, ".codehost", "config.yaml"))).toBe(true);
    expect(existsSync(join(home, ".codehost", "setup.sh"))).toBe(true);
    expect(existsSync(join(home, ".codehost", "setup.ps1"))).toBe(true);
  });

  test("config.yaml is valid YAML with a workspace template", () => {
    const home = mkHome();
    scaffoldCodehost(home);
    const cfg = parseYaml(readFileSync(join(home, ".codehost", "config.yaml"), "utf8"));
    expect(cfg.workspace).toBe("ws/{owner}/{repo}/tree/{branch}");
  });

  test("setup.sh keeps shell vars literal (no JS interpolation leaked)", () => {
    const home = mkHome();
    scaffoldCodehost(home);
    const sh = readFileSync(join(home, ".codehost", "setup.sh"), "utf8");
    expect(sh).toContain("$CODEHOST_WS");
    expect(sh).toContain("${ws%/tree/$CODEHOST_BRANCH}");
    expect(sh).toContain("git -C \"$repo\" worktree add");
  });

  test("idempotent: a second run writes nothing; --force overwrites", () => {
    const home = mkHome();
    expect(scaffoldCodehost(home)).toHaveLength(3);
    expect(scaffoldCodehost(home)).toHaveLength(0);
    expect(scaffoldCodehost(home, true)).toHaveLength(3);
  });
});
