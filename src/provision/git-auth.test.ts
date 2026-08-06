import { expect, test } from "bun:test";
import { GIT_AUTH_ERROR_RE } from "./git-auth";

test("GIT_AUTH_ERROR_RE matches git's auth-shaped failures", () => {
  const lines = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Repository not found.",
    "fatal: repository 'https://github.com/o/private-repo/' not found",
    "fatal: Authentication failed for 'https://github.com/o/r/'",
    "git@github.com: Permission denied (publickey).",
    "remote: Invalid username or token.",
  ];
  for (const l of lines) expect(GIT_AUTH_ERROR_RE.test(l)).toBe(true);
});

test("GIT_AUTH_ERROR_RE ignores ordinary provisioning output", () => {
  const lines = [
    "[setup] cloning https://github.com/o/r.git",
    "Cloning into 'r'...",
    "remote: Counting objects: 100% (5/5), done.",
    "[setup] ready: /ws/o/r/tree/main",
    "error: pathspec 'nope' did not match any file(s) known to git",
  ];
  for (const l of lines) expect(GIT_AUTH_ERROR_RE.test(l)).toBe(false);
});
