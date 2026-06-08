import { describe, expect, test } from "bun:test";
import { parseDeepLink, pickRoomMatch, repoKey, shareableDeepLink, toPosixPath } from "./repo";
import { parseGitRemote } from "../cli/git";

describe("toPosixPath", () => {
  // VS Code web's ?folder= on Windows wants the file-URI authority form
  // (/C:/ws), NOT git-bash /c/ws — the latter reports "workspace does not exist".
  test("Windows drive path -> /<Drive>:/... (file-URI form)", () => {
    expect(toPosixPath("C:\\ws")).toBe("/C:/ws");
    expect(toPosixPath("C:\\Users\\taku")).toBe("/C:/Users/taku");
  });

  test("preserves drive-letter case (drive is case-insensitive on Windows)", () => {
    expect(toPosixPath("D:\\foo")).toBe("/D:/foo");
    expect(toPosixPath("c:\\ws")).toBe("/c:/ws");
  });

  test("drive root collapses to /<Drive>: (no trailing slash)", () => {
    expect(toPosixPath("C:\\")).toBe("/C:");
    expect(toPosixPath("C:")).toBe("/C:");
  });

  test("forward-slash Windows paths normalize too", () => {
    expect(toPosixPath("C:/ws")).toBe("/C:/ws");
  });

  test("POSIX absolute paths are unchanged (mac/linux not broken)", () => {
    expect(toPosixPath("/Users/sno/ws")).toBe("/Users/sno/ws");
    expect(toPosixPath("/home/x/proj")).toBe("/home/x/proj");
    expect(toPosixPath("/")).toBe("/");
  });

  test("already-normalized path is idempotent", () => {
    expect(toPosixPath("/C:/ws")).toBe("/C:/ws");
  });

  test("trims trailing backslashes/slashes on a drive path", () => {
    expect(toPosixPath("C:\\ws\\")).toBe("/C:/ws");
  });

  // Regression: the value VS Code web receives via ?folder= (URL-decoded) must
  // be exactly /C:/ws so serve-web resolves it to the real C:\ws on disk.
  test("?folder= round-trip: encode(toPosixPath) decodes back to /C:/ws", () => {
    const folderParam = encodeURIComponent(toPosixPath("C:\\ws"));
    expect(folderParam).toBe("%2FC%3A%2Fws");
    expect(decodeURIComponent(folderParam)).toBe("/C:/ws");
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
    const dl = parseDeepLink("/dev/Users/sno/ws");
    expect(dl?.type === "dev" && dl.target.path).toBe("/Users/sno/ws");
  });

  test("/dev/<Windows drive path> round-trips (colon in a non-leading segment)", () => {
    // shareableDeepLink -> address bar -> parseDeepLink must preserve /C:/ws.
    const path = shareableDeepLink({ folder: toPosixPath("C:\\ws") })!;
    expect(path).toBe("/dev/C:/ws");
    const dl = parseDeepLink(path);
    expect(dl?.type === "dev" && dl.target.path).toBe("/C:/ws");
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

  test("no repo -> /dev/<folder> (Windows drive path preserved)", () => {
    expect(shareableDeepLink({ folder: "/C:/ws" })).toBe("/dev/C:/ws");
    expect(shareableDeepLink({ folder: "/Users/sno/ws" })).toBe("/dev/Users/sno/ws");
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
