import { expect, test } from "bun:test";
import { deriveTags, matchQuery, matchToken, roomDisplayLabel, roomLabels, shortRoomLabel } from "./tags";

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

test("roomDisplayLabel names a room after its servers", () => {
  const t = "super-secret-token-value-1234567890";
  expect(roomDisplayLabel(t, ["tak.local"])).toBe("tak.local");
  // Duplicates collapse (a host advertising both name and hostname).
  expect(roomDisplayLabel(t, ["tak.local", "tak.local", "mbp"])).toBe("tak.local+1");
  // Empty room falls back to the token hash; blank names don't count.
  expect(roomDisplayLabel(t, [])).toBe(shortRoomLabel(t));
  expect(roomDisplayLabel(t, ["", ""])).toBe(shortRoomLabel(t));
  // Multi-server labels stay whitespace-free so `room:` filter tokens work.
  expect(roomDisplayLabel(t, ["a", "b"])).not.toMatch(/\s/);
});

test("roomLabels leaves unique names bare", () => {
  const labels = roomLabels([
    { token: "token-aaaa-1234567890", servers: [{ name: "mbp", user: "taku" }] },
    { token: "token-bbbb-1234567890", servers: [{ name: "studio", user: "taku" }] },
  ]);
  expect(labels.get("token-aaaa-1234567890")).toBe("mbp");
  expect(labels.get("token-bbbb-1234567890")).toBe("studio");
});

test("roomLabels disambiguates collisions by user, then room hash", () => {
  // Same machine name, different users → user@name.
  const byUser = roomLabels([
    { token: "token-aaaa-1234567890", servers: [{ name: "mbp", user: "taku" }] },
    { token: "token-bbbb-1234567890", servers: [{ name: "mbp", user: "sno" }] },
  ]);
  expect(byUser.get("token-aaaa-1234567890")).toBe("taku@mbp");
  expect(byUser.get("token-bbbb-1234567890")).toBe("sno@mbp");

  // Same name AND same user → the room hash breaks the tie.
  const byHash = roomLabels([
    { token: "token-aaaa-1234567890", servers: [{ name: "mbp", user: "taku" }] },
    { token: "token-bbbb-1234567890", servers: [{ name: "mbp", user: "taku" }] },
  ]);
  const a = byHash.get("token-aaaa-1234567890")!;
  const b = byHash.get("token-bbbb-1234567890")!;
  expect(a).not.toBe(b);
  expect(a).toBe(`taku@mbp·${shortRoomLabel("token-aaaa-1234567890")}`);

  // No user advertised (older daemons) → straight to the hash.
  const noUser = roomLabels([
    { token: "token-aaaa-1234567890", servers: [{ name: "mbp" }] },
    { token: "token-bbbb-1234567890", servers: [{ name: "mbp" }] },
  ]);
  expect(noUser.get("token-aaaa-1234567890")).toBe(`mbp·${shortRoomLabel("token-aaaa-1234567890")}`);
});

test("roomLabels keeps empty rooms on the hash fallback", () => {
  const t = "token-aaaa-1234567890";
  expect(roomLabels([{ token: t, servers: [] }]).get(t)).toBe(shortRoomLabel(t));
});

test("shortRoomLabel is stable and exactly 4 chars", () => {
  const t = "super-secret-token-value-1234567890";
  expect(shortRoomLabel(t)).toBe(shortRoomLabel(t));
  expect(shortRoomLabel(t)).toHaveLength(4);
  expect(shortRoomLabel("another-token")).not.toBe(shortRoomLabel(t));
});
