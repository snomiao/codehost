import { describe, expect, test } from "bun:test";
import { parseDeepLink, pickRoomMatch, repoKey, shareableDeepLink, toPosixPath } from "./repo";
import { parseGitRemote } from "../cli/git";

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

describe("parseGitRemote", () => {
  test("GitHub https / ssh / git@ -> host-agnostic key", () => {
    expect(parseGitRemote("https://github.com/snomiao/codehost.git")).toBe("github.com/snomiao/codehost");
    expect(parseGitRemote("git@github.com:snomiao/codehost.git")).toBe("github.com/snomiao/codehost");
    expect(parseGitRemote("ssh://git@github.com/snomiao/codehost")).toBe("github.com/snomiao/codehost");
  });

  test("other hosts work too (gitlab, bitbucket, self-hosted with port)", () => {
    expect(parseGitRemote("https://gitlab.com/group/proj.git")).toBe("gitlab.com/group/proj");
    expect(parseGitRemote("git@bitbucket.org:team/repo.git")).toBe("bitbucket.org/team/repo");
    expect(parseGitRemote("ssh://git@git.company.com:2222/team/svc.git")).toBe("git.company.com/team/svc");
  });

  test("lowercases host, strips .git, ignores deeper path segments", () => {
    expect(parseGitRemote("https://GitHub.com/Owner/Repo")).toBe("github.com/Owner/Repo");
    expect(parseGitRemote("https://gitlab.com/group/sub/proj.git")).toBe("gitlab.com/group/sub");
  });

  test("returns undefined for empty / unparseable / single-segment remotes", () => {
    expect(parseGitRemote("")).toBeUndefined();
    expect(parseGitRemote("not a url")).toBeUndefined();
    expect(parseGitRemote("https://github.com/onlyowner")).toBeUndefined();
  });
});

describe("parseDeepLink + repoKey round-trip", () => {
  test("/gh/owner/repo -> github.com key", () => {
    const dl = parseDeepLink("/gh/snomiao/codehost");
    expect(dl?.type).toBe("repo");
    if (dl?.type === "repo") {
      expect(repoKey(dl.target)).toBe("github.com/snomiao/codehost");
      expect(dl.target.branch).toBeUndefined();
    }
  });

  test("/gh/owner/repo/tree/branch keeps the branch (slashes allowed)", () => {
    const dl = parseDeepLink("/gh/snomiao/codehost/tree/feat/x");
    expect(dl?.type === "repo" && dl.target.branch).toBe("feat/x");
  });

  test("/git/<host>/owner/repo -> that host's key", () => {
    const dl = parseDeepLink("/git/gitlab.com/group/proj/tree/dev");
    expect(dl?.type).toBe("repo");
    if (dl?.type === "repo") {
      expect(repoKey(dl.target)).toBe("gitlab.com/group/proj");
      expect(dl.target.branch).toBe("dev");
    }
  });

  test("/dev/<path> -> dev target with leading slash", () => {
    const dl = parseDeepLink("/dev/c/ws");
    expect(dl?.type === "dev" && dl.target.path).toBe("/c/ws");
  });

  test("non-deep-link -> null", () => {
    expect(parseDeepLink("/")).toBeNull();
    expect(parseDeepLink("/settings")).toBeNull();
  });
});

describe("shareableDeepLink", () => {
  test("GitHub repo -> /gh sugar", () => {
    expect(shareableDeepLink({ repo: "github.com/snomiao/codehost", branch: "main" })).toBe(
      "/gh/snomiao/codehost/tree/main",
    );
    expect(shareableDeepLink({ repo: "github.com/snomiao/codehost" })).toBe("/gh/snomiao/codehost");
  });

  test("other host -> /git/<host>/...", () => {
    expect(shareableDeepLink({ repo: "gitlab.com/group/proj", branch: "dev" })).toBe(
      "/git/gitlab.com/group/proj/tree/dev",
    );
  });

  test("no repo -> /dev/<folder>", () => {
    expect(shareableDeepLink({ folder: "/c/ws" })).toBe("/dev/c/ws");
  });

  test("nothing addressable -> null", () => {
    expect(shareableDeepLink({})).toBeNull();
  });

  test("round-trips: shareableDeepLink output parses back to the same key", () => {
    const path = shareableDeepLink({ repo: "gitlab.com/group/proj", branch: "dev" })!;
    const dl = parseDeepLink(path);
    expect(dl?.type === "repo" && repoKey(dl.target)).toBe("gitlab.com/group/proj");
  });
});

describe("pickRoomMatch (cross-room ranking)", () => {
  const exact = { token: "tA", resolution: { peerId: "p1" } }; // no folder = exact
  const root = { token: "tB", resolution: { peerId: "p2", folder: "/work/me/repo" } };

  test("exact match (no folder) beats a root fallback, regardless of order", () => {
    expect(pickRoomMatch([root, exact])?.token).toBe("tA");
    expect(pickRoomMatch([exact, root])?.token).toBe("tA");
  });

  test("only root fallbacks -> first root", () => {
    const root2 = { token: "tC", resolution: { peerId: "p3", folder: "/x" } };
    expect(pickRoomMatch([root, root2])?.token).toBe("tB");
  });

  test("no matches -> null", () => {
    expect(pickRoomMatch([])).toBeNull();
  });
});
