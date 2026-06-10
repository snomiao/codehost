import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT } from "../shared/repo";
import { enumerateWorkspaces } from "./workspaces";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "codehost-ws-"));
}

/** Create a checkout dir; .git is a dir by default, a file when `worktree`. */
function checkout(root: string, rel: string, worktree = false): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  if (worktree) writeFileSync(join(dir, ".git"), "gitdir: elsewhere");
  else mkdirSync(join(dir, ".git"));
}

describe("enumerateWorkspaces", () => {
  test("walks the default layout and reports repo identity + branch", () => {
    const root = makeRoot();
    checkout(root, "snomiao/codehost/tree/main");
    checkout(root, "symval/symval/tree/dev", true); // worktree-style .git file
    mkdirSync(join(root, "snomiao/empty/tree/main"), { recursive: true }); // no .git

    const found = enumerateWorkspaces(root, DEFAULT_LAYOUT);
    expect(found).toHaveLength(2);
    expect(found).toContainEqual({
      path: join(root, "snomiao/codehost/tree/main"),
      repo: "github.com/snomiao/codehost",
      branch: "main",
    });
    expect(found).toContainEqual({
      path: join(root, "symval/symval/tree/dev"),
      repo: "github.com/symval/symval",
      branch: "dev",
    });
  });

  test("literal segments must exist; placeholders match one level", () => {
    const root = makeRoot();
    checkout(root, "ws/snomiao/codehost"); // layout ws/{owner}/{repo}
    checkout(root, "other/snomiao/codehost"); // doesn't match the literal "ws"

    const found = enumerateWorkspaces(root, "ws/{owner}/{repo}");
    expect(found).toHaveLength(1);
    expect(found[0].repo).toBe("github.com/snomiao/codehost");
    expect(found[0].branch).toBeUndefined();
  });

  test("skips dot-directories and tolerates a missing root", () => {
    const root = makeRoot();
    checkout(root, ".hidden/codehost/tree/main");
    expect(enumerateWorkspaces(root, DEFAULT_LAYOUT)).toHaveLength(0);
    expect(enumerateWorkspaces(join(root, "nope"), DEFAULT_LAYOUT)).toHaveLength(0);
  });

  test("uses the given git host in repo identity", () => {
    const root = makeRoot();
    checkout(root, "group/proj/tree/main");
    const found = enumerateWorkspaces(root, DEFAULT_LAYOUT, "gitlab.com");
    expect(found[0].repo).toBe("gitlab.com/group/proj");
  });
});
