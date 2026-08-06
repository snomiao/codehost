import { spawnSync } from "node:child_process";

// Non-interactive probes of the host's git/GitHub credential state. Used to
// turn git's misleading private-repo failure ("repository not found" — GitHub
// hides private repos from unauthenticated eyes) into an actionable
// "no credentials on this host" message, both in the provisioning stream and
// in `codehost setup`'s closing summary.

/** Env that forbids every interactive credential path: git's terminal prompt,
 *  askpass popups, and Git Credential Manager's UI. A daemon has no terminal,
 *  so anything interactive means a silent hang until the provision timeout. */
export const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
} as const;

/**
 * True if git can produce credentials for `https://<host>` without prompting —
 * i.e. some configured helper (gh's `gh auth setup-git`, osxkeychain,
 * `credential.helper store`, GCM…) answered with a password/token. False means
 * a private-repo clone on this machine cannot succeed.
 */
export function hasGitCredentials(host = "github.com"): boolean {
  const r = spawnSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...GIT_NO_PROMPT_ENV, LC_ALL: "C" },
  });
  return r.status === 0 && /(^|\n)password=.+/.test(r.stdout ?? "");
}

/** True if the GitHub CLI is installed (regardless of auth state). */
export function hasGhCli(): boolean {
  const r = spawnSync("gh", ["--version"], { stdio: "ignore", timeout: 10_000 });
  return r.status === 0;
}

/** Output lines a daemon's setup-script stream matches to spot an auth-shaped
 *  git failure (prompts are disabled, so these fail fast and loud). */
export const GIT_AUTH_ERROR_RE =
  /could not read Username|terminal prompts disabled|Authentication failed|[Rr]epository (['"].*['"] )?not found|Permission denied \(publickey\)|Invalid username or (password|token)/;

/**
 * Human guidance for an auth-shaped clone failure, tailored to what's actually
 * missing on this machine. Returns one string per line; empty when credentials
 * exist (the failure is then a real not-found / no-access, not a setup gap).
 */
export function gitAuthHint(host = "github.com"): string[] {
  if (hasGitCredentials(host)) {
    return [
      `⚠ this repo wasn't accessible — it may not exist, or the ${host} account this`,
      `host is authenticated as may lack access. Check the URL and your repo permissions.`,
    ];
  }
  const install = hasGhCli() ? [] : ["   (install it first: https://cli.github.com)"];
  return [
    `⚠ this repo may be private, and no ${host} credentials are available on this host.`,
    "To fix, run on the host:",
    "   gh auth login && gh auth setup-git",
    ...install,
    "then retry this link.",
  ];
}
