import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { readConfig } from "../config";
import { repoIdentity } from "../git";
import { GITHUB_HOST, gitUrlToPath, shareableDeepLink } from "../../shared/repo";
import { PAGE_URL, openBrowser } from "../open-url";

interface OpenArgs {
  target?: string;
  token?: string;
  anon: boolean;
  page: string;
  print: boolean;
}

export const openCommand: CommandModule<{}, OpenArgs> = {
  command: "open [target]",
  describe: "Open a codehost deep link in the browser (defaults to the repo in the current directory)",
  builder: (y) =>
    y
      .positional("target", {
        describe:
          "What to open: a repo (owner/repo, a git URL, or gh/git/host/dev path) or a full URL. Omit to use the git repo in the current directory.",
        type: "string",
      })
      .option("token", {
        alias: "t",
        describe: "Token to embed for auto-connect (defaults to the saved room token)",
        type: "string",
      })
      .option("anon", {
        describe: "Open without embedding a token",
        type: "boolean",
        default: false,
      })
      .option("page", { describe: "Page URL to open against", type: "string", default: PAGE_URL })
      .option("print", {
        describe: "Print the URL instead of opening a browser",
        type: "boolean",
        default: false,
      }) as any,
  handler: async (argv) => {
    const url = buildUrl(argv);
    console.log(`[codehost] ${url}`);
    if (argv.print) return;
    openBrowser(url);
  },
};

/**
 * Resolve the URL to open. A full non-git URL is used verbatim; otherwise we
 * build a codehost deep-link path (reusing the same helpers the page resolves
 * with) and, unless `--anon`, append the room token in the `#t=<token>` fragment
 * so the page auto-connects (the fragment stays in the browser). With no target
 * we derive the path from the git repo in the current directory.
 */
function buildUrl(argv: OpenArgs): string {
  const target = argv.target?.trim();

  // A full non-repo URL is opened as-is. (A repo URL like
  // https://github.com/o/r is turned into a deep link below.)
  if (target && /^https?:\/\//i.test(target) && !gitUrlToPath(target)) return target;

  const path = target ? pathFromTarget(target) : pathFromCwd();
  const base = `${argv.page.replace(/\/+$/, "")}${path}`;

  const token = argv.anon ? undefined : (argv.token?.trim() || readConfig().token);
  return token ? `${base}#t=${encodeURIComponent(token)}` : base;
}

/** Map a positional target to a deep-link path (always starts with `/`). */
function pathFromTarget(target: string): string {
  const clean = target.replace(/^\/+/, "");
  // Already a known deep-link shape — pass through.
  if (/^(gh|git|host|dev)\//.test(clean)) return `/${clean}`;
  // A git URL / scp / host/owner/repo (dotted host), incl. /tree/<branch>.
  const fromUrl = gitUrlToPath(target);
  if (fromUrl) return fromUrl;
  // Bare `owner/repo[/tree/branch]` -> GitHub deep link.
  const m = clean.match(/^([^/]+)\/([^/]+)(?:\/tree\/(.+))?$/);
  if (m) return shareableDeepLink({ repo: `${GITHUB_HOST}/${m[1]}/${m[2]}`, branch: m[3] }) ?? "/";
  // Anything else (e.g. a folder path) -> legacy host-agnostic folder mount.
  return `/dev/${clean}`;
}

/** Derive a deep-link path from the git repo in the current directory. */
function pathFromCwd(): string {
  const { repo, branch } = repoIdentity(resolve(process.cwd()));
  const path = repo ? shareableDeepLink({ repo, branch }) : null;
  if (!path) {
    console.error("[codehost] no git repo found here; opening the codehost home page");
    return "/";
  }
  return path;
}
