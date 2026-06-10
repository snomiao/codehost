import { describe, expect, test } from "bun:test";
import { gitUrlToPath, parseDeepLink, pickRoomMatch, repoKey, resolveDevTarget, resolveRepoTarget, shareableDeepLink, toPosixPath } from "./repo";
import type { PeerInfo } from "./signaling";
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

  test("/host/<hostname>/<path> -> host-scoped dev target", () => {
    const dl = parseDeepLink("/host/Mac/Users/taku");
    expect(dl?.type === "dev" && dl.target.host).toBe("Mac");
    expect(dl?.type === "dev" && dl.target.path).toBe("/Users/taku");
  });

  test("/host/<hostname>/<Windows drive path> round-trips", () => {
    const path = shareableDeepLink({ folder: "/C:/ws", host: "EC2AMAZ-PH8C4K1" })!;
    expect(path).toBe("/host/EC2AMAZ-PH8C4K1/C:/ws");
    const dl = parseDeepLink(path);
    expect(dl?.type === "dev" && dl.target.host).toBe("EC2AMAZ-PH8C4K1");
    expect(dl?.type === "dev" && dl.target.path).toBe("/C:/ws");
  });

  test("legacy /dev/<path> still parses host-agnostic (no host)", () => {
    const dl = parseDeepLink("/dev/C:/ws");
    expect(dl?.type === "dev" && dl.target.host).toBeUndefined();
    expect(dl?.type === "dev" && dl.target.path).toBe("/C:/ws");
  });

  test("non-deep-link -> null", () => {
    expect(parseDeepLink("/")).toBeNull();
    expect(parseDeepLink("/settings")).toBeNull();
  });
});

describe("resolveDevTarget host scoping", () => {
  const mk = (peerId: string, host: string, cwd: string): PeerInfo => ({
    peerId,
    role: "server",
    meta: { name: host, host, cwd },
  });
  // Same served path on two different machines — the ambiguity host scoping fixes.
  const servers = [mk("pA", "boxA", "/C:/ws"), mk("pB", "boxB", "/C:/ws")];

  test("host-scoped target picks the matching host", () => {
    expect(resolveDevTarget(servers, { host: "boxB", path: "/C:/ws" })?.peerId).toBe("pB");
    expect(resolveDevTarget(servers, { host: "boxA", path: "/C:/ws" })?.peerId).toBe("pA");
  });

  test("host-scoped target with no matching host -> null (won't cross machines)", () => {
    expect(resolveDevTarget(servers, { host: "boxC", path: "/C:/ws" })).toBeNull();
  });

  test("legacy host-agnostic target matches by path alone", () => {
    expect(resolveDevTarget(servers, { path: "/C:/ws" })?.peerId).toBe("pA");
  });

  test("leading/trailing slash differences still match (e.g. expose cwd)", () => {
    const ex = [mk("pE", "boxE", "localhost:8090")];
    expect(resolveDevTarget(ex, { host: "boxE", path: "/localhost:8090" })?.peerId).toBe("pE");
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

describe("resolveRepoTarget root selection", () => {
  const root = (peerId: string, cwd: string): PeerInfo => ({
    peerId,
    role: "server",
    meta: { name: peerId, host: "Mac", cwd, kind: "root" },
  });

  test("among nested roots, picks the deepest (longest cwd)", () => {
    const servers = [root("shallow", "/Users/sno"), root("deep", "/Users/sno/ws")];
    const res = resolveRepoTarget(servers, { host: "github.com", owner: "snomiao", name: "codehost" });
    expect(res?.peerId).toBe("deep");
    expect(res?.folder).toBe("/Users/sno/ws/snomiao/codehost/tree/main");
  });

  test("an exact repo daemon still wins over any root", () => {
    const servers: PeerInfo[] = [
      root("deep", "/Users/sno/ws"),
      { peerId: "exact", role: "server", meta: { name: "x", host: "Mac", cwd: "/x", repo: "github.com/snomiao/codehost" } },
    ];
    expect(resolveRepoTarget(servers, { host: "github.com", owner: "snomiao", name: "codehost" })?.peerId).toBe("exact");
  });
});

describe("gitUrlToPath", () => {
  test("github URLs -> /gh, preserving branch (incl. slashes)", () => {
    expect(gitUrlToPath("https://github.com/snomiao/codehost")).toBe("/gh/snomiao/codehost");
    expect(gitUrlToPath("https://github.com/snomiao/codehost/tree/main")).toBe("/gh/snomiao/codehost/tree/main");
    expect(gitUrlToPath("github.com/snomiao/codehost")).toBe("/gh/snomiao/codehost");
    expect(gitUrlToPath("https://github.com/snomiao/codehost.git")).toBe("/gh/snomiao/codehost");
    expect(gitUrlToPath("https://github.com/snomiao/codehost/tree/feat/x")).toBe("/gh/snomiao/codehost/tree/feat/x");
    expect(gitUrlToPath("https://github.com/snomiao/codehost/")).toBe("/gh/snomiao/codehost");
    expect(gitUrlToPath("https://github.com/snomiao/codehost?tab=readme#x")).toBe("/gh/snomiao/codehost");
  });

  test("other hosts + scp form -> /git/<host>/...", () => {
    expect(gitUrlToPath("https://gitlab.com/group/proj/tree/dev")).toBe("/git/gitlab.com/group/proj/tree/dev");
    expect(gitUrlToPath("git@github.com:snomiao/codehost.git")).toBe("/gh/snomiao/codehost");
  });

  test("non-repo / junk -> null", () => {
    expect(gitUrlToPath("")).toBeNull();
    expect(gitUrlToPath("not a url")).toBeNull();
    expect(gitUrlToPath("https://github.com/snomiao")).toBeNull(); // no repo
    expect(gitUrlToPath("/gh/snomiao/codehost")).toBeNull(); // already a deep link, no host
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
