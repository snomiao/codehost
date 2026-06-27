import { afterEach, describe, expect, test } from "bun:test";
import {
  folderFor,
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
