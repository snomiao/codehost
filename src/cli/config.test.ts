import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHostId, readConfig, writeConfig } from "./config";

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), "codehost-config-")), "config.json");

describe("ensureHostId", () => {
  test("mints a UUID once and returns the same id on later calls", () => {
    const file = tmpConfig();
    const first = ensureHostId(file);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureHostId(file)).toBe(first);
    expect(readConfig(file).hostId).toBe(first);
  });

  test("preserves other config fields when minting", () => {
    const file = tmpConfig();
    writeConfig({ token: "Str0ng-Token-99" }, file);
    const id = ensureHostId(file);
    const config = JSON.parse(readFileSync(file, "utf8"));
    expect(config).toEqual({ token: "Str0ng-Token-99", hostId: id });
  });

  test("returns an existing hostId without rewriting", () => {
    const file = tmpConfig();
    writeConfig({ hostId: "pre-existing-id" }, file);
    expect(ensureHostId(file)).toBe("pre-existing-id");
  });
});
