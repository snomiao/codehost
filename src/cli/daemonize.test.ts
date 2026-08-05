import { describe, expect, test } from "bun:test";
import { buildForegroundArgv } from "./daemonize";

const base = { dir: "/Users/x/repo", token: "Str0ng-Token-99", signal: "wss://signal.codehost.dev", host: "box" };

describe("buildForegroundArgv", () => {
  test("passes values with `=` so a leading-dash token isn't parsed as flags", () => {
    // nanoid tokens may start with "-"; `-t <token>` made yargs swallow it as
    // flags, so the daemon died on a missing --token and printed help instead.
    const argv = buildForegroundArgv({ ...base, command: "dev", token: "-MLDkoss9hKTBudPXfTD95kmaA1-" });
    expect(argv).toContain("--token=-MLDkoss9hKTBudPXfTD95kmaA1-");
    expect(argv).not.toContain("-t");
  });

  test("carries the subcommand, positional and optional flags", () => {
    const argv = buildForegroundArgv({ ...base, command: "expose", arg: "3000", name: "-box", allow: ["-chrome*"], port: 8080 });
    expect(argv.slice(2, 4)).toEqual(["expose", "3000"]);
    expect(argv).toContain("--signal=wss://signal.codehost.dev");
    expect(argv).toContain("--name=-box");
    expect(argv).toContain("--port=8080");
    expect(argv).toContain("--allow=-chrome*");
  });

  test("dev stays standalone; serve does not", () => {
    expect(buildForegroundArgv({ ...base, command: "dev" })).toContain("--standalone");
    expect(buildForegroundArgv({ ...base, command: "serve" })).not.toContain("--standalone");
  });
});
