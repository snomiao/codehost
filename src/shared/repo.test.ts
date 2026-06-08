import { describe, expect, test } from "bun:test";
import { toPosixPath } from "./repo";

describe("toPosixPath", () => {
  test("Windows drive path -> POSIX drive form", () => {
    expect(toPosixPath("C:\\ws")).toBe("/c/ws");
    expect(toPosixPath("C:\\Users\\x")).toBe("/c/Users/x");
  });

  test("lowercases the drive letter", () => {
    expect(toPosixPath("D:\\foo")).toBe("/d/foo");
    expect(toPosixPath("c:\\ws")).toBe("/c/ws");
  });

  test("drive root collapses to /<letter> (no trailing slash)", () => {
    expect(toPosixPath("C:\\")).toBe("/c");
    expect(toPosixPath("C:")).toBe("/c");
  });

  test("forward-slash Windows paths normalize too", () => {
    expect(toPosixPath("C:/ws")).toBe("/c/ws");
  });

  test("POSIX absolute paths are unchanged (mac/linux not broken)", () => {
    expect(toPosixPath("/Users/sno/ws")).toBe("/Users/sno/ws");
    expect(toPosixPath("/home/x/proj")).toBe("/home/x/proj");
    expect(toPosixPath("/")).toBe("/");
  });

  test("already-normalized POSIX-drive path is a no-op", () => {
    expect(toPosixPath("/c/ws")).toBe("/c/ws");
  });

  test("trims trailing backslashes/slashes on a drive path", () => {
    expect(toPosixPath("C:\\ws\\")).toBe("/c/ws");
  });
});
