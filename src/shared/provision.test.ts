import { describe, expect, test } from "bun:test";
import { repoAllowed, resolveWorkspacePath, validateProvisionTarget } from "./provision";

describe("validateProvisionTarget — the injection boundary", () => {
  test("accepts normal identities", () => {
    const r = validateProvisionTarget("snomiao", "codehost", "main");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ owner: "snomiao", repo: "codehost", branch: "main" });
  });

  test("accepts branch with slashes and hyphens", () => {
    const r = validateProvisionTarget("snomiao", "codehost", "feat/some-thing");
    expect(r.ok).toBe(true);
  });

  test("empty branch defaults to main", () => {
    const r = validateProvisionTarget("snomiao", "codehost", "");
    expect(r.ok && r.target.branch).toBe("main");
  });

  // The whole point: these must NOT pass.
  test("rejects path traversal in owner/repo", () => {
    expect(validateProvisionTarget("..", "codehost", "main").ok).toBe(false);
    expect(validateProvisionTarget(".", "codehost", "main").ok).toBe(false);
    expect(validateProvisionTarget("snomiao", "..", "main").ok).toBe(false);
    expect(validateProvisionTarget("a/b", "codehost", "main").ok).toBe(false); // slash
    expect(validateProvisionTarget(".ssh", "codehost", "main").ok).toBe(false); // leading dot
  });

  test("rejects traversal / leading-dash / junk in branch", () => {
    expect(validateProvisionTarget("o", "r", "a/../../etc").ok).toBe(false);
    expect(validateProvisionTarget("o", "r", "..").ok).toBe(false);
    expect(validateProvisionTarget("o", "r", "-x").ok).toBe(false); // option injection
    expect(validateProvisionTarget("o", "r", "feat/-x").ok).toBe(false);
    expect(validateProvisionTarget("o", "r", "a b").ok).toBe(false); // whitespace
    expect(validateProvisionTarget("o", "r", "a;rm -rf").ok).toBe(false); // shell meta
    expect(validateProvisionTarget("o", "r", "a$(id)").ok).toBe(false);
    expect(validateProvisionTarget("o", "r", "a`id`").ok).toBe(false);
  });
});

describe("resolveWorkspacePath — daemon-authoritative, cannot escape home", () => {
  test("fills the default layout under home", () => {
    const t = { owner: "snomiao", repo: "codehost", branch: "main" };
    expect(resolveWorkspacePath("/Users/sno/ws", "", t)).toBe("/Users/sno/ws/snomiao/codehost/tree/main");
  });

  test("honors a custom layout template (e.g. config.yaml ws/ home model)", () => {
    const t = { owner: "snomiao", repo: "codehost", branch: "feat/x" };
    expect(resolveWorkspacePath("/home/me", "ws/{owner}/{repo}/tree/{branch}", t)).toBe(
      "/home/me/ws/snomiao/codehost/tree/feat/x",
    );
  });

  test("a validated target can never produce a path above home", () => {
    // Only validated targets reach here; confirm the segments are inert.
    const v = validateProvisionTarget("snomiao", "codehost", "main");
    expect(v.ok).toBe(true);
    if (v.ok) {
      const p = resolveWorkspacePath("/Users/sno/ws", "{owner}/{repo}/tree/{branch}", v.target);
      expect(p.startsWith("/Users/sno/ws/")).toBe(true);
      expect(p.includes("/../")).toBe(false);
    }
  });
});

describe("repoAllowed", () => {
  test("empty/absent allowlist allows all", () => {
    expect(repoAllowed("github.com/x/y", undefined)).toBe(true);
    expect(repoAllowed("github.com/x/y", [])).toBe(true);
  });

  test("exact + owner wildcard", () => {
    expect(repoAllowed("github.com/snomiao/codehost", ["github.com/snomiao/codehost"])).toBe(true);
    expect(repoAllowed("github.com/snomiao/codehost", ["github.com/snomiao/*"])).toBe(true);
    expect(repoAllowed("github.com/evil/repo", ["github.com/snomiao/*"])).toBe(false);
    expect(repoAllowed("gitlab.com/snomiao/x", ["github.com/snomiao/*"])).toBe(false);
  });
});
