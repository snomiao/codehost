import { expect, test } from "bun:test";
import { deriveTags, matchQuery, matchToken, shortRoomLabel } from "./tags";

test("deriveTags builds mnemonic tags from meta", () => {
  const tags = deriveTags(
    { name: "x", host: "mbp", cwd: "/ws/a", kind: "repo", repo: "github.com/o/r", branch: "main" },
    { roomLabel: "ab12" },
  );
  expect(tags).toContain("room:ab12");
  expect(tags).toContain("host:mbp");
  expect(tags).toContain("kind:repo");
  expect(tags).toContain("repo:github.com/o/r");
  expect(tags).toContain("wt:main");
  expect(tags).toContain("cwd:/ws/a");
});

test("deriveTags defaults kind to repo and omits absent fields", () => {
  const tags = deriveTags({ name: "x", host: "h", cwd: "" });
  expect(tags).toContain("kind:repo");
  expect(tags).not.toContain("cwd:");
  expect(tags.some((t) => t.startsWith("repo:"))).toBe(false);
});

test("key:value matches by tag key + substring value", () => {
  const e = { name: "server", tags: ["repo:github.com/snomiao/codehost", "host:mbp"] };
  expect(matchToken(e, "repo:codehost")).toBe(true);
  expect(matchToken(e, "repo:other")).toBe(false);
  expect(matchToken(e, "host:mbp")).toBe(true);
});

test("bare text is a substring across name and tags", () => {
  const e = { name: "my-laptop", tags: ["repo:github.com/snomiao/codehost"] };
  expect(matchToken(e, "snomiao")).toBe(true);
  expect(matchToken(e, "laptop")).toBe(true);
  expect(matchToken(e, "nope")).toBe(false);
});

test("bare numeric is an exact pid match", () => {
  const e = { name: "x", pid: "1234", tags: [] };
  expect(matchToken(e, "1234")).toBe(true);
  expect(matchToken(e, "123")).toBe(false);
});

test("matchQuery ANDs all tokens", () => {
  const e = { name: "x", tags: ["host:mbp", "repo:github.com/o/codehost", "kind:repo"] };
  expect(matchQuery(e, "codehost host:mbp")).toBe(true);
  expect(matchQuery(e, "codehost host:other")).toBe(false);
  expect(matchQuery(e, "")).toBe(true);
});

test("shortRoomLabel is stable and exactly 4 chars", () => {
  const t = "super-secret-token-value-1234567890";
  expect(shortRoomLabel(t)).toBe(shortRoomLabel(t));
  expect(shortRoomLabel(t)).toHaveLength(4);
  expect(shortRoomLabel("another-token")).not.toBe(shortRoomLabel(t));
});
