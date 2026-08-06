import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  folderFor,
  forkWorktree,
  parseSource,
  parseSpec,
  resolveWsRoot,
  WS_ROOT,
} from "./index";

describe("parseSource", () => {
  const spec = (owner: string, repo: string, branch: string) => ({
    owner,
    repo,
    branch,
  });

  test("github URL forms (with and without scheme)", () => {
    expect(parseSource("https://github.com/o/r/tree/main")).toEqual(
      spec("o", "r", "main"),
    );
    expect(parseSource("github.com/o/r/tree/main")).toEqual(
      spec("o", "r", "main"),
    );
    expect(parseSource("https://www.github.com/o/r/tree/main")).toEqual(
      spec("o", "r", "main"),
    );
  });

  test("bare <o>/<r>/tree/<b> delegates to parseSpec", () => {
    expect(parseSource("o/r/tree/main")).toEqual(spec("o", "r", "main"));
  });

  test("<o>/<r>@<branch> normalizes to tree/<branch>", () => {
    expect(parseSource("o/r@dev")).toEqual(spec("o", "r", "dev"));
    expect(parseSource("o/r@feat/x")).toEqual(spec("o", "r", "feat/x"));
  });

  test("bare <o>/<r> defaults branch to main", () => {
    expect(parseSource("o/r")).toEqual(spec("o", "r", "main"));
  });

  test("branch may contain slashes", () => {
    expect(parseSource("o/r/tree/feat/a/b")).toEqual(
      spec("o", "r", "feat/a/b"),
    );
  });

  test("strips trailing .git and #/? fragments", () => {
    expect(parseSource("o/r.git")).toEqual(spec("o", "r", "main"));
    expect(parseSource("https://github.com/o/r.git#readme")).toEqual(
      spec("o", "r", "main"),
    );
    expect(parseSource("o/r/tree/main?foo=1")).toEqual(spec("o", "r", "main"));
  });

  test("rejects path traversal and option injection", () => {
    expect(parseSource("../etc/passwd")).toBeNull();
    expect(parseSource("o/--evil/tree/main")).toBeNull();
    expect(parseSource("o/r/tree/--upload-pack=x")).toBeNull();
    expect(parseSource("")).toBeNull();
    expect(parseSource("just-one-segment")).toBeNull();
  });
});

describe("parseSpec + folderFor", () => {
  test("folderFor maps under WS_ROOT/owner/repo/tree/branch", () => {
    const s = parseSpec("o/r/tree/main")!;
    expect(folderFor(s)).toBe(`${WS_ROOT}/o/r/tree/main`);
  });
});

describe("workspace root override (call-time)", () => {
  const orig = process.env.CODEHOST_WS_ROOT;
  afterEach(() => {
    if (orig === undefined) delete process.env.CODEHOST_WS_ROOT;
    else process.env.CODEHOST_WS_ROOT = orig;
  });

  test("precedence: explicit arg > env > ~/ws default", () => {
    delete process.env.CODEHOST_WS_ROOT;
    expect(resolveWsRoot()).toBe(WS_ROOT);
    expect(resolveWsRoot("/code")).toBe("/code");

    process.env.CODEHOST_WS_ROOT = "/env/root";
    expect(resolveWsRoot()).toBe("/env/root");
    expect(resolveWsRoot("/code")).toBe("/code"); // explicit still wins
  });

  test("folderFor honors an explicit wsRoot (e.g. /code layout)", () => {
    const s = parseSpec("snomiao/codehost/tree/main")!;
    expect(folderFor(s, "/code")).toBe("/code/snomiao/codehost/tree/main");
  });

  test("folderFor honors CODEHOST_WS_ROOT when no arg given", () => {
    process.env.CODEHOST_WS_ROOT = "/code";
    const s = parseSpec("snomiao/codehost/tree/main")!;
    expect(folderFor(s)).toBe("/code/snomiao/codehost/tree/main");
  });
});

describe("forkWorktree", () => {
  const tmps: string[] = [];
  const mk = (p: string) => {
    const d = mkdtempSync(path.join(tmpdir(), p));
    tmps.push(d);
    return d;
  };
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: GIT_ENV });
  afterEach(() => {
    for (const d of tmps.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // worktree links may resist rm; best-effort
      }
    }
  });

  const seedRepo = (prefix: string) => {
    const src = mk(prefix);
    git(src, "init", "-q", "-b", "main");
    git(src, "remote", "add", "origin", "https://github.com/test/repo.git");
    writeFileSync(path.join(src, "tracked.txt"), "base\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "init");
    return src;
  };

  test("forks current HEAD clean by default — uncommitted work does NOT cross over", async () => {
    const src = seedRepo("ch-fork-src-");
    const wsRoot = mk("ch-fork-ws-");
    // dirty: modify a tracked file + add an untracked (non-ignored) file
    writeFileSync(path.join(src, "tracked.txt"), "WIP change\n");
    writeFileSync(path.join(src, "new.txt"), "new untracked\n");

    const r = await forkWorktree({ fromCwd: src, branch: "feat-x", wsRoot });

    expect(r.ok).toBe(true);
    expect(r.action).toBe("forked");
    expect(r.folder).toBe(path.join(wsRoot, "test", "repo", "tree", "feat-x"));
    // fork is clean: committed state only, no WIP carried:
    expect(readFileSync(path.join(r.folder, "tracked.txt"), "utf8")).toBe("base\n");
    expect(existsSync(path.join(r.folder, "new.txt"))).toBe(false);
    // source worktree is untouched (its WIP is still there):
    expect(readFileSync(path.join(src, "tracked.txt"), "utf8")).toBe("WIP change\n");
    expect(existsSync(path.join(src, "new.txt"))).toBe(true);
  });

  test("carries tracked + untracked WIP when wip: true", async () => {
    const src = seedRepo("ch-fork-wip-src-");
    const wsRoot = mk("ch-fork-wip-ws-");
    // dirty: modify a tracked file + add an untracked (non-ignored) file
    writeFileSync(path.join(src, "tracked.txt"), "WIP change\n");
    writeFileSync(path.join(src, "new.txt"), "new untracked\n");

    const r = await forkWorktree({ fromCwd: src, branch: "feat-x", wsRoot, wip: true });

    expect(r.ok).toBe(true);
    expect(r.action).toBe("forked");
    // uncommitted work made it across:
    expect(readFileSync(path.join(r.folder, "tracked.txt"), "utf8")).toBe("WIP change\n");
    expect(readFileSync(path.join(r.folder, "new.txt"), "utf8")).toBe("new untracked\n");
    // source worktree is untouched (its WIP is still there):
    expect(readFileSync(path.join(src, "tracked.txt"), "utf8")).toBe("WIP change\n");
    expect(existsSync(path.join(src, "new.txt"))).toBe(true);
  });

  test("rejects an unsafe branch name", async () => {
    const src = seedRepo("ch-fork-src2-");
    const r = await forkWorktree({ fromCwd: src, branch: "../evil", wsRoot: mk("ch-fork-ws2-") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid branch");
  });

  test("errors when fromCwd is not a git worktree", async () => {
    const r = await forkWorktree({
      fromCwd: mk("ch-fork-nogit-"),
      branch: "x",
      wsRoot: mk("ch-fork-ws3-"),
    });
    expect(r.ok).toBe(false);
  });
});
