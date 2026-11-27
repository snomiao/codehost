#!/usr/bin/env node
// Writes rs/parity.json, the parity cases for codehost (Rust against
// TypeScript).
//
//   node rs/parity.gen.mjs           # rewrite rs/parity.json
//   node rs/parity.gen.mjs --check   # fail if rs/parity.json is not what this writes
//   node rs/parity.gen.mjs --list    # print the case names
//
// Then, from the repository root, after `bun install` and a release build:
//
//   sh rs/parity/proof.sh <rustify>/templates/parity/parity.mjs rs/target/release/codehost
//
// which runs every case against both implementations, then the hand-back
// check, then `cargo test` (see the script).
//
// What a case compares: stdout, stderr and the exit code; what each
// implementation asked git (rs/parity/run.sh puts a git that logs its
// arguments first on PATH); and what is left in the case's directory and
// home directory, names, modes and contents.
//
// A case says who is expected to answer it:
//   add(...)   the binary answers;
//   back(...)  the binary hands it back to the JavaScript: a spelling or a
//              command that is yargs's to answer, a state of the machine the
//              binary does not reproduce.
//
// What no case does, and the generator refuses to write:
//   - run `open` without `--print` (it opens the browser), or with a word
//     that could make `--print` false;
//   - run serve, dev or expose with a token the policy accepts, except dev
//     with a live host daemon registered (it then only writes to
//     workspaces.json), and serve with no dir in the empty home (it then
//     stops at `no workspace root configured`); and never with -d or without
//     `--signal ws://127.0.0.1:1`, nor with --standalone unless every token
//     is one the policy rejects (the handler checks it first and exits). If
//     a case were wrong, the TypeScript would find no VS Code
//     (CODEHOST_CODE_BIN points nowhere) and no signaling server;
//   - run setup, list, stop, update or __supervise, which reach process
//     managers, the network or VS Code.
// The home directory is the runner's empty one; no real token is used.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "parity.json");

const sq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// ── what a case looks at afterwards ──────────────────────────────────────────

/** Everything below a directory: kind, mode and path, then the contents. */
const tree = (dir) =>
  `cd ${dir} && find . -mindepth 1 -printf '%y %m %p\\n' | sort && find . -type f | sort | while IFS= read -r f; do echo "== $f"; cat "$f"; echo; done`;
const HOME_STATE = tree("<HOME>");
const CWD_STATE = tree("<CWD>");
/** Every git command the implementation ran, in order. */
const GIT_LOG = 'cat "$TMPDIR/git.log" 2>/dev/null || echo "(git not run)"';
/** Whether a browser was asked to open anything. */
const BROWSER_LOG = 'cat "$TMPDIR/browser.log" 2>/dev/null || echo "(no browser)"';

const SIGNAL = ["--signal", "ws://127.0.0.1:1"];

// ── safety: a JavaScript copy of validateToken, to refuse dangerous cases ────

function policyAccepts(token) {
  const t = token.trim();
  if (t.length < 12 || t.length > 256 || /\s/.test(t)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(t)).length;
  if (classes < 3) return false;
  return !["changeme1234", "password1234", "codehost1234", "letmein12345"].includes(t.toLowerCase());
}

function tokensIn(args) {
  const found = [];
  args.forEach((arg, i) => {
    if (arg === "-t" || arg === "--token") found.push(args[i + 1] ?? "");
    else if (arg.startsWith("--token=")) found.push(arg.slice(8));
  });
  return found;
}

function refuseDanger(c) {
  const [command, ...rest] = c.args;
  const all = c.args.join(" ");
  if (["setup", "list", "ls", "stop", "update", "__supervise"].includes(command)) throw new Error(`${c.name}: never run ${command}`);
  if (command === "open" && !c.args.some((a) => ["--help", "-h", "help"].includes(a))) {
    if (!rest.includes("--print")) throw new Error(`${c.name}: open without --print opens the browser`);
    if (rest.some((a) => a === "false" || a.startsWith("--print=") || a.startsWith("--no-") || a === "--noPrint")) {
      throw new Error(`${c.name}: --print could be false`);
    }
  }
  if (["serve", "dev", "expose"].includes(command)) {
    if (!all.includes(SIGNAL.join(" "))) throw new Error(`${c.name}: every server case points --signal at a closed port`);
    if (rest.some((a) => ["-d", "--daemon"].includes(a) || a.startsWith("--daemon"))) {
      throw new Error(`${c.name}: no -d`);
    }
    const tokens = tokensIn(rest);
    if (rest.some((a) => a.startsWith("--standalone")) && !(tokens.length > 0 && !tokens.some(policyAccepts))) {
      throw new Error(`${c.name}: --standalone only with a token the policy rejects`);
    }
    const accepted = tokens.some(policyAccepts);
    if (accepted && !(command === "dev" && c.liveDaemon) && !servesNoRoot(c)) throw new Error(`${c.name}: a token the policy accepts would start a server`);
  }
}

/** `serve` with nothing but the closed `--signal` and a token: no dir, no
 *  setup, no files, no variables of its own. In the runner's empty home
 *  nothing is remembered, so the TypeScript stops with `no workspace root
 *  configured` (exit 1) right after the token check, before it writes,
 *  starts or connects anything (serve.ts:135). Such a case says so with
 *  `noRoot: true`. */
function servesNoRoot(c) {
  const [command, ...rest] = c.args;
  if (command !== "serve" || !c.noRoot || c.setup || c.files || c.env || rest.length % 2 !== 0) return false;
  for (let i = 0; i < rest.length; i += 2) {
    const [option, value] = [rest[i], rest[i + 1]];
    if (option === "--signal" ? value !== SIGNAL[1] : !["-t", "--token"].includes(option) || value.startsWith("-")) return false;
  }
  return true;
}

// ── cases ────────────────────────────────────────────────────────────────────

const cases = [];
function add(name, spec) {
  const c = { name, ...spec };
  refuseDanger(c);
  const { liveDaemon, noRoot, ...kept } = c;
  cases.push(kept);
}
function back(name, why, spec) {
  add(name, { ...spec, handback: why });
}

/** A git repository in <CWD>/<dir> (or <CWD>), made with the runner's git. */
function repo(dir = ".", { origin, commit = false, branch, more = [] } = {}) {
  const git = `git -C ${sq(dir)}`;
  const lines = [`mkdir -p ${sq(dir)}`, `${git} init -q -b main`];
  if (origin !== undefined) lines.push(`${git} remote add origin ${sq(origin)}`);
  if (commit) lines.push(`${git} -c user.name=p -c user.email=p@p commit -q --allow-empty -m init`);
  if (branch) lines.push(`${git} checkout -q -b ${sq(branch)}`);
  return [...lines, ...more.map((line) => line.replaceAll("@GIT@", git))];
}

/** A file under <HOME>/.codehost. */
const codehostFile = (name, content) => `mkdir -p <HOME>/.codehost && printf '%s' ${sq(content)} > <HOME>/.codehost/${name}`;

// ── open: targets ────────────────────────────────────────────────────────────

const OPEN_AFTER = [GIT_LOG, BROWSER_LOG];

const TARGETS = [
  "owner/repo",
  "owner/repo/tree/main",
  "owner/repo/tree/feat/x/y",
  "/owner/repo",
  "//gh/owner/repo",
  "gh/o/r",
  "gh/o",
  "git/gitlab.com/g/p/tree/dev",
  "host/Mac/Users/x",
  "dev/C:/ws",
  "sno@Mac",
  "sno@Mac/github.com/o/r/tree/main",
  "@Mac/x",
  "x@",
  "a@b@c/d",
  "a@/b",
  // scp-style with a user: taken as <user>@<machine> (a quirk of open.ts)
  "git@github.com:Foo/Bar.git",
  "github.com:o/r",
  "gitlab.com/group/proj.git",
  "gitlab.com/group/proj.GIT",
  "GitHub.COM/O/R/",
  "x.y/a/b.git.git",
  "x.y/a/.git",
  "x.y/a/b/tree",
  "x.y/a/b/c",
  "https://github.com/snomiao/codehost",
  "HTTPS://GitHub.COM/a/b.git/tree/feat/x?y#z",
  "https://github.com/a/b/tree/x?y=1",
  "http://gitlab.com/g/p.git#frag",
  "https://user:pw@github.com/a/b",
  "ssh://git@git.company.com:2222/team/svc.git",
  "git+ssh://git@github.com/o/r.git",
  "https://github.com:443/a/b",
  // full URLs that are not repositories: printed as they are, no token
  "https://localhost:8080/a/b",
  "https://example.com/",
  "https://example.com/a",
  "http://127.0.0.1:5173/x?y#z",
  "HTTP://EXAMPLE.COM",
  "ftp://example.com/a/b",
  "a/b/c",
  "a/b/tree",
  "a/b/tree/",
  "C:\\ws",
  "some folder/with space",
  "ü/😀",
  "null",
  "0x1F",
  "1e3",
  "  owner/repo  ",
  "\towner/repo\n",
  "owner/repo/tree/a\nb",
  "owner\u00a0/repo",
  "\u2028owner/repo\ufeff",
  "owner/repo\u0085",
  "a%2Fb/c",
  "o/r#frag",
  "o/r?x=1",
  ".",
  "..",
  "~",
  "/",
  "///",
];
for (const target of TARGETS) {
  add(`open target ${JSON.stringify(target)}`, { args: ["open", "--print", "--anon", target], after: OPEN_AFTER });
}
for (const target of ["owner/repo", "https://example.com/a", "git@github.com:Foo/Bar.git", "a/b/c"]) {
  add(`open target ${JSON.stringify(target)} with a token`, { args: ["open", "--print", "-t", "Tok/en+ü&#?", target], after: OPEN_AFTER });
}
for (const target of ["", "   "]) {
  add(`open blank target ${JSON.stringify(target)} uses the current directory`, { args: ["open", "--print", "--anon", target], after: OPEN_AFTER });
}

// ── open: options ────────────────────────────────────────────────────────────

const OPTION_LINES = [
  ["--print", "owner/repo"],
  ["owner/repo", "--print"],
  ["-t", "tok", "--print", "owner/repo"],
  ["--token", "tok", "--print", "owner/repo"],
  ["--token=tok", "--print", "owner/repo"],
  ["--token=a=b", "--print", "owner/repo"],
  ["--token=", "--print", "owner/repo"],
  ["-t", "", "--print", "owner/repo"],
  ["-t", "   ", "--print", "owner/repo"],
  ["-t", " a b ", "--print", "owner/repo"],
  ["-t", "😀\u2028é", "--print", "owner/repo"],
  ["-t", "x-_.!~*'()", "--print", "owner/repo"],
  ["-t", "1e3", "--print", "owner/repo"],
  ["--anon", "-t", "x", "--print", "owner/repo"],
  ["--print", "--page", "https://x.dev//", "owner/repo"],
  ["--print", "--page=http://localhost:5173", "owner/repo"],
  ["--print", "--page", "", "owner/repo"],
  ["--print", "--page", "/", "owner/repo"],
  ["--print", "--page", "a b", "-t", "x", "owner/repo"],
  ["--print", "--page", "123", "owner/repo"],
  ["--print", "--page", "https://x.dev/", "https://example.com/a"],
  ["-t", "x", "owner/repo", "--anon", "--print", "--page", "https://p.dev"],
];
for (const line of OPTION_LINES) add(`open ${JSON.stringify(line.join(" "))}`, { args: ["open", ...line], after: OPEN_AFTER });

// ── open: the saved token (~/.codehost/config.json) ──────────────────────────

const CONFIGS = [
  ["a saved token", '{\n  "token": "Saved-Token-1",\n  "hostId": "h"\n}'],
  ["a saved token with escapes", '{"token": "s\\u00e9 \\/x\\ud83d\\ude00"}'],
  ["an empty saved token", '{"token": ""}'],
  ["a null token", '{"token": null}'],
  ["no token", '{"hostId": "x", "root": "/x"}'],
  ["an empty object", "{}"],
  ["an array", "[1]"],
  ["a string", '"str"'],
  ["a number", "5"],
  ["a token under __proto__", '{"__proto__": {"token": "x"}}'],
];
for (const [what, content] of CONFIGS) {
  add(`open with ${what} in config.json`, {
    setup: [codehostFile("config.json", content)],
    args: ["open", "--print", "owner/repo"],
    after: [...OPEN_AFTER, HOME_STATE],
  });
}
add("open with a saved token and no repo here", { setup: [codehostFile("config.json", '{"token": "Saved-Token-1"}')], args: ["open", "--print"], after: OPEN_AFTER });
add("open -t wins over the saved token", { setup: [codehostFile("config.json", '{"token": "Saved-Token-1"}')], args: ["open", "--print", "-t", "mine", "o/r"], after: OPEN_AFTER });
add("open -t with config.json null (not read)", { setup: [codehostFile("config.json", "null")], args: ["open", "--print", "-t", "x", "o/r"], after: OPEN_AFTER });
add("open --anon with config.json null (not read)", { setup: [codehostFile("config.json", "null")], args: ["open", "--print", "--anon", "o/r"], after: OPEN_AFTER });
add("open a full URL with config.json null (not read)", { setup: [codehostFile("config.json", "null")], args: ["open", "--print", "https://example.com/a"], after: OPEN_AFTER });
add("open with config.json a dangling link", { setup: ["mkdir -p <HOME>/.codehost && ln -s nowhere <HOME>/.codehost/config.json"], args: ["open", "--print", "o/r"], after: OPEN_AFTER });
back("open with config.json null", "`null.token` throws: the runtime's report", { setup: [codehostFile("config.json", "null")], args: ["open", "--print", "o/r"] });
back("open with a numeric token", "JavaScript's number formatting", { setup: [codehostFile("config.json", '{"token": 5}')], args: ["open", "--print", "o/r"] });
back("open with config.json not JSON", "JSON.parse's verdict is not reproduced", { setup: [codehostFile("config.json", "{bad")], args: ["open", "--print", "o/r"] });
back("open with config.json empty", "JSON.parse's verdict is not reproduced", { setup: [codehostFile("config.json", "")], args: ["open", "--print", "o/r"] });
back("open with config.json behind a byte order mark", "not compared", { setup: [codehostFile("config.json", '\ufeff{"token": "x"}')], args: ["open", "--print", "o/r"] });
back("open with a key twice in config.json", "not compared", { setup: [codehostFile("config.json", '{"token": "a", "token": "b"}')], args: ["open", "--print", "o/r"] });
back("open with config.json a directory", "not compared", { setup: ["mkdir -p <HOME>/.codehost/config.json"], args: ["open", "--print", "o/r"] });

// ── open: the repository of the current directory ────────────────────────────

const REPOS = [
  ["a repository without origin", {}],
  ["origin over https, no commit yet", { origin: "https://github.com/Owner/Repo.git" }],
  ["origin scp-style", { origin: "git@GitHub.com:Owner/Repo.git" }],
  ["origin ssh with a port", { origin: "ssh://git@git.company.com:2222/team/svc.git" }],
  ["origin git://", { origin: "git://example.org/o/r" }],
  ["origin in a GitLab subgroup", { origin: "https://gitlab.com/group/sub/proj.git" }],
  ["origin ending .git/", { origin: "https://github.com/o/r.GIT/" }],
  ["origin of one segment", { origin: "https://github.com/onlyowner" }],
  ["origin not a URL", { origin: "not a url" }],
  ["origin a local path", { origin: "/srv/git/repo.git" }],
  ["origin with a user and password", { origin: "https://u:p@example.com:8443/o/r" }],
  ["a commit on main", { origin: "https://github.com/o/r", commit: true }],
  ["a branch with slashes", { origin: "https://github.com/o/r", commit: true, branch: "feat/x/y" }],
  ["a detached HEAD", { origin: "https://github.com/o/r", commit: true, more: ["@GIT@ checkout -q --detach"] }],
  ["a branch named HEAD-like", { origin: "https://github.com/o/r", commit: true, branch: "HEADx" }],
  ["origin rewritten by insteadOf", { origin: "gh:o/r", more: ["@GIT@ config url.https://github.com/.insteadOf gh:"] }],
];
for (const [what, spec] of REPOS) {
  add(`open in ${what}`, { setup: repo(".", spec), args: ["open", "--print", "--anon"], after: OPEN_AFTER });
}
add("open in a subdirectory of a repository", {
  setup: [...repo(".", { origin: "https://github.com/o/r" }), "mkdir -p sub/deeper"],
  env: { PARITY_CD: "sub/deeper" },
  args: ["open", "--print", "-t", "x"],
  after: OPEN_AFTER,
});
add("open inside .git", { setup: repo(".", { origin: "https://github.com/o/r" }), env: { PARITY_CD: ".git" }, args: ["open", "--print", "--anon"], after: OPEN_AFTER });
add("open in a bare repository", { setup: ["git init -q --bare -b main"], args: ["open", "--print", "--anon"], after: OPEN_AFTER });
add("open in a linked worktree", {
  setup: [...repo("main", { origin: "https://github.com/o/r", commit: true }), "git -C main worktree add -q -b wt/x ../wt"],
  env: { PARITY_CD: "wt" },
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
add("open with GIT_DIR naming another repository", {
  setup: [...repo("other", { origin: "https://github.com/other/one" }), ...repo(".", { origin: "https://github.com/o/r" })].map((line) => `env -u GIT_DIR ${line}`),
  env: { GIT_DIR: "<CWD>/other/.git" },
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
add("open with a saved token, in a repository", {
  setup: [...repo(".", { origin: "https://github.com/o/r", commit: true }), codehostFile("config.json", '{"token": "Saved Token+1"}')],
  args: ["open", "--print"],
  after: OPEN_AFTER,
});
add("open with no git on PATH", { setup: repo(".", { origin: "https://github.com/o/r" }), env: { PARITY_NO_GIT: "1" }, args: ["open", "--print", "--anon"], after: [BROWSER_LOG] });
back("open in a repository whose host is not ASCII", "toLowerCase beyond ASCII is not compared", {
  setup: repo(".", { origin: "https://GÏTHUB.com/o/r" }),
  args: ["open", "--print", "--anon"],
});
back("open a target whose host is not ASCII", "toLowerCase beyond ASCII is not compared", { args: ["open", "--print", "--anon", "https://GÏTHUB.com/o/r"] });

// ── what bun reads before the program ────────────────────────────────────────

const PACKAGE = '{\n  "name": "x",\n  "type": "module",\n  "exports": { ".": "./a.js", "./b": { "import": "./b.js" } },\n  "scripts": { "t": "x" }\n}\n';
add("open in a JavaScript project", { files: { "package.json": PACKAGE, "tsconfig.json": '// c\n{"compilerOptions": {"strict": true,},}\n' }, args: ["open", "--print", "--anon", "o/r"] });
add("open below a JavaScript project", {
  files: { "package.json": PACKAGE, "jsconfig.json": '{"compilerOptions": {"paths": {"@/*": ["./src/*"]}}}' },
  setup: ["mkdir -p sub"],
  env: { PARITY_CD: "sub" },
  args: ["open", "--print", "--anon", "o/r"],
});
for (const [what, file, content] of [
  ["package.json that does not parse", "package.json", "{bad"],
  ["package.json with a key twice", "package.json", '{"a": 1, "a": 2}'],
  ["package.json with an unknown type", "package.json", '{"type": "Module"}'],
  ["package.json with an exports map bun rejects", "package.json", '{"exports": {".": "./a.js", "x": "./b.js"}}'],
  ["package.json with a browser map bun rejects", "package.json", '{"browser": {"a": 5}}'],
  ["tsconfig.json with extends", "tsconfig.json", '{"extends": "./base.json"}'],
  ["tsconfig.json with paths bun rejects", "tsconfig.json", '{"compilerOptions": {"paths": {"a": 5}}}'],
  ["jsconfig.json with a key twice", "jsconfig.json", '{"compilerOptions": {"a": 1, "a": 2}}'],
  ["package.json in single quotes", "package.json", "{'a': 1}"],
  ["package.json that is a directory", "package.json/x", ""],
]) {
  back(`open beside a ${what}`, "bun writes its warnings first, or the file was not compared", { files: { [file]: content }, args: ["open", "--print", "--anon", "o/r"] });
}
back("open below a package.json that does not parse", "bun reads the files above the current directory too", {
  files: { "package.json": "{bad" },
  setup: ["mkdir -p sub"],
  env: { PARITY_CD: "sub" },
  args: ["open", "--print", "--anon", "o/r"],
});
back("open beside a .env setting variables that are not set", "bun loads them, and git inherits them", {
  files: { ".env": "FOO=1\nGITHUB_TOKEN=not-a-real-one\n" },
  args: ["open", "--print", "--anon", "o/r"],
});
add("open beside a .env setting HOME and PATH (set ones win)", {
  files: { ".env": "HOME=/elsewhere\nPATH=/nowhere\n" },
  setup: [codehostFile("config.json", '{"token": "Saved-Token-1"}')],
  args: ["open", "--print", "o/r"],
  after: OPEN_AFTER,
});
back("open beside a .env setting GIT_DIR", "bun loads it into the environment git reads", {
  files: { ".env": "GIT_DIR=<CWD>/other/.git\n" },
  setup: [...repo("other", { origin: "https://github.com/other/one" }), ...repo(".", { origin: "https://github.com/o/r" })],
  args: ["open", "--print", "--anon"],
});
back("open beside a .env.local setting XDG_CONFIG_HOME", "bun loads it into the environment git reads", { files: { ".env.local": "XDG_CONFIG_HOME=/x\n" }, args: ["open", "--print", "--anon", "o/r"] });
back("open beside a .env.production mentioning NODE", "not compared", { files: { ".env.production": "NODE_ENV=production\n" }, args: ["open", "--print", "--anon", "o/r"] });
back("open beside a bunfig.toml", "bun reads it before the program", { files: { "bunfig.toml": "[install]\nexact = true\n" }, args: ["open", "--print", "--anon", "o/r"] });
back("open with a ~/.bunfig.toml", "bun reads it before the program", { setup: ["printf '[install]\\nexact = true\\n' > <HOME>/.bunfig.toml"], args: ["open", "--print", "--anon", "o/r"] });
back("open with NODE_ENV set", "a variable for the runtime", { env: { NODE_ENV: "production" }, args: ["open", "--print", "--anon", "o/r"] });
back("open with a BUN_ variable set", "a variable for the runtime", { env: { BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1" }, args: ["open", "--print", "--anon", "o/r"] });
add("open with BUN_INSTALL set", { env: { BUN_INSTALL: "/opt/bun" }, args: ["open", "--print", "--anon", "o/r"] });
back("open with FORCE_COLOR and a line on stderr", "console.error is coloured", { env: { FORCE_COLOR: "1" }, args: ["open", "--print", "--anon"] });
add("open with FORCE_COLOR and nothing on stderr", { env: { FORCE_COLOR: "1" }, args: ["open", "--print", "--anon", "o/r"] });
back("open with FORCE_COLOR in a repository", "the binary declines before asking git whether stderr is needed", {
  env: { FORCE_COLOR: "1" },
  setup: repo(".", { origin: "https://github.com/o/r" }),
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
add("open with NO_COLOR and a line on stderr", { env: { NO_COLOR: "1" }, args: ["open", "--print", "--anon"], after: OPEN_AFTER });
back("open with a relative directory in PATH", "where git is looked up is not compared", { env: { PARITY_PATH_PREFIX: "bin" }, args: ["open", "--print", "--anon", "o/r"] });
back("open with CODEHOST_NO_NATIVE=1", "the way out: everything goes back", { env: { CODEHOST_NO_NATIVE: "1" }, args: ["open", "--print", "--anon", "o/r"] });
back("init with CODEHOST_NO_NATIVE=1", "the way out: everything goes back", { env: { CODEHOST_NO_NATIVE: "1" }, args: ["init"], after: [CWD_STATE] });
add("open from a linked directory in a repository", {
  setup: [...repo("real", { origin: "https://github.com/o/r", commit: true, branch: "b" }), "ln -s real link"],
  env: { PARITY_CD: "link" },
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
add("init from a linked directory", { setup: ["mkdir real && ln -s real link"], env: { PARITY_CD: "link" }, args: ["init", "ws"], after: [CWD_STATE] });
add("open from a directory with spaces and ü", { setup: [...repo("my dir ü", { origin: "https://github.com/o/r" })], env: { PARITY_CD: "my dir ü" }, args: ["open", "--print", "--anon"], after: OPEN_AFTER });

// ── open: spellings yargs answers ────────────────────────────────────────────

for (const line of [
  ["--print", "--help"],
  ["--help"],
  ["-h", "--print"],
  ["--print", "help"],
  ["help", "--print"],
  ["--print", "--version"],
  ["--print", "-t", "x", "-t", "y", "o/r"],
  ["--print", "--print", "o/r"],
  ["--print", "o/r", "extra"],
  ["--print", "--", "o/r"],
  ["--print", "-tabc", "o/r"],
  ["--print", "-t=abc", "o/r"],
  ["--print", "--unknown", "o/r"],
  ["--print", "true"],
  ["--print", "--anon", "true", "o/r"],
  ["--print", "--token=-x", "o/r"],
  ["--print", "-t", "-x", "o/r"],
  ["-t", "-_.!~*'()", "--print", "owner/repo"],
  ["--print", "-t"],
  ["--print", "--page.x=1", "o/r"],
  ["--print", "-"],
  ["--print", "---"],
  ["--print", "--Print", "o/r"],
]) {
  back(`open ${JSON.stringify(line.join(" "))}`, "yargs's to answer", { args: ["open", ...line] });
}
back("no command", "yargs's to answer", { args: [] });
back("--help", "yargs's to answer", { args: ["--help"] });
back("-h", "yargs's to answer", { args: ["-h"] });
back("--version", "yargs's to answer", { args: ["--version"] });
back("an unknown command", "yargs's to answer", { args: ["OPEN", "--print", "o/r"] });
back("an option before the command", "yargs's to answer", { args: ["--print", "open", "o/r"] });
back("init --help", "yargs's to answer", { args: ["init", "--help"] });
back("serve --help", "yargs's to answer", { args: ["serve", "--help", ...SIGNAL] });

// ── init ─────────────────────────────────────────────────────────────────────

const INIT_AFTER = [CWD_STATE];
const CUSTOM_YAML = 'workspace: "{repo}"\n';
add("init here", { args: ["init"], after: INIT_AFTER });
add("init .", { args: ["init", "."], after: INIT_AFTER });
add("init a new directory", { args: ["init", "ws"], after: INIT_AFTER });
add("init a new nested directory", { args: ["init", "a/b/c"], after: INIT_AFTER });
add("init an existing directory", { setup: ["mkdir ws"], args: ["init", "ws"], after: INIT_AFTER });
add("init an absolute path", { args: ["init", "<CWD>/abs"], after: INIT_AFTER });
add("init a path to normalise", { args: ["init", "a//b/./c/../d/"], after: INIT_AFTER });
add("init above the current directory", { setup: ["mkdir -p sub"], env: { PARITY_CD: "sub" }, args: ["init", "../up"], after: INIT_AFTER });
add("init a directory with spaces and ü", { args: ["init", "my ws ü"], after: INIT_AFTER });
add("init a directory with a backslash", { args: ["init", "a\\b"], after: INIT_AFTER });
add("init twice: already set up", { setup: ["mkdir -p .codehost && touch .codehost/config.yaml .codehost/setup.sh .codehost/setup.ps1"], args: ["init"], after: INIT_AFTER });
add("init with config.yaml there already", { files: { ".codehost/config.yaml": CUSTOM_YAML }, args: ["init"], after: INIT_AFTER });
add("init with setup.sh there already, mode 644", { files: { ".codehost/setup.sh": "echo mine\n" }, setup: ["chmod 644 .codehost/setup.sh"], args: ["init"], after: INIT_AFTER });
add("init -f over everything", {
  files: { ".codehost/config.yaml": CUSTOM_YAML, ".codehost/setup.sh": "echo mine\n", ".codehost/setup.ps1": "mine\n" },
  setup: ["chmod 600 .codehost/setup.sh .codehost/config.yaml"],
  args: ["init", "-f"],
  after: INIT_AFTER,
});
add("init --force a directory", { files: { "ws/.codehost/setup.ps1": "mine\n" }, args: ["init", "--force", "ws"], after: INIT_AFTER });
add("init ws -f", { args: ["init", "ws", "-f"], after: INIT_AFTER });
add("init with config.yaml a directory", { setup: ["mkdir -p .codehost/config.yaml"], args: ["init"], after: INIT_AFTER });
add("init into a linked .codehost", { setup: ["mkdir real && ln -s real .codehost"], args: ["init"], after: INIT_AFTER });
add("init in a JavaScript project", { files: { "package.json": PACKAGE }, args: ["init"], after: INIT_AFTER });
back("init -f with config.yaml a directory", "writeFileSync fails: the runtime's report", { setup: ["mkdir -p .codehost/config.yaml"], args: ["init", "-f"], after: INIT_AFTER });
back("init with .codehost a file", "mkdirSync fails: the runtime's report", { files: { ".codehost": "x" }, args: ["init"], after: INIT_AFTER });
back("init below a file", "mkdirSync fails: the runtime's report", { files: { f: "x" }, args: ["init", "f/ws"], after: INIT_AFTER });
back("init with setup.sh a link", "existsSync follows links; not compared", { setup: ["mkdir .codehost && echo x > t && ln -s ../t .codehost/setup.sh"], args: ["init"], after: INIT_AFTER });
back("init with setup.sh a dangling link", "existsSync follows links; not compared", { setup: ["mkdir .codehost && ln -s ../nowhere .codehost/setup.sh"], args: ["init"], after: INIT_AFTER });
back("init with .codehost a dangling link", "not compared", { setup: ["ln -s nowhere .codehost"], args: ["init"], after: INIT_AFTER });
for (const line of [["-f", "-f"], ["a", "b"], ["--force=true"], ["--no-force"], ["-x"], [""], ["help"], ["--", "ws"], ["-fx"]]) {
  back(`init ${JSON.stringify(line.join(" "))}`, "yargs's to answer", { args: ["init", ...line], after: INIT_AFTER });
}

// ── the room-token policy: serve, dev, expose ────────────────────────────────

const REJECTED = [
  "short",
  "",
  "   ",
  "Aa1-aaaaaaa",
  "aaaaaaaaaaaa",
  "AAAAAAAAAAAA",
  "123456789012",
  "aaaaaa123456",
  "Aa1 Bb2 Cc3 Dd4",
  "Aa1-\u00a0aaaaaaaa",
  "Aa1-\u2028aaaaaaaa",
  "Aa1-\ufeffaaaaaaaa",
  "Aa1-\u3000aaaaaaaa",
  "Aa1-\taaaaaaaa",
  "  short  ",
  "Changeme1234",
  "Password1234",
  "LetMeIn12345",
  "CodeHost1234",
  "codehost1234",
  "😀😀😀😀😀😀",
  "😀😀😀😀😀",
  "ééééééééééé1",
  `Aa1-${"x".repeat(253)}`,
  `Aa1-${"😀".repeat(127)}`,
];
for (const token of REJECTED) {
  if (policyAccepts(token)) throw new Error(`the policy accepts ${JSON.stringify(token)}`);
}
const shown = (token) => JSON.stringify(token.length > 40 ? `${token.slice(0, 12)}… (${token.length} units)` : token);
for (const token of REJECTED) {
  add(`serve -t ${shown(token)}`, { args: ["serve", ...SIGNAL, "-t", token], after: [HOME_STATE, GIT_LOG] });
}
for (const token of ["short", "Changeme1234", "😀😀😀😀😀😀", "Aa1-\u00a0aaaaaaaa", ""]) {
  add(`dev -t ${shown(token)}`, { args: ["dev", ...SIGNAL, "-t", token], after: [HOME_STATE, GIT_LOG] });
  add(`expose 8080 -t ${shown(token)}`, { args: ["expose", "8080", ...SIGNAL, "-t", token], after: [HOME_STATE] });
}
add("serve --token=short", { args: ["serve", ...SIGNAL, "--token=short"] });
add("serve --token short with a dir", { args: ["serve", "ws", ...SIGNAL, "--token", "short"], after: [CWD_STATE, HOME_STATE] });
add("serve with every option it takes and a bad token", {
  args: ["serve", "ws", "--name", "x", ...SIGNAL, "--port", "8080", "--approve", "confirm", "-t", "short"],
  after: [CWD_STATE, HOME_STATE],
});
add("serve --approve auto with a bad token", { args: ["serve", "--approve=auto", ...SIGNAL, "-t", "short"] });
add("dev with every option it takes and a bad token", { args: ["dev", "ws", "--name", "x", ...SIGNAL, "--port", "1", "--approve", "auto", "-t", "short"] });
add("expose a port out of range with a bad token", { args: ["expose", "70000", ...SIGNAL, "-t", "short"] });
add("expose 0 with a bad token", { args: ["expose", "0", ...SIGNAL, "--name", "n", "-t", "short"] });
add("serve with a bad token in a JavaScript project", { files: { "package.json": PACKAGE }, args: ["serve", ...SIGNAL, "-t", "short"] });
back("serve without -t", "yargs's to answer", { args: ["serve", ...SIGNAL] });
back("serve with an --approve yargs rejects", "yargs's to answer", { args: ["serve", ...SIGNAL, "--approve", "maybe", "-t", "short"] });
back("serve with --allow", "--allow is greedy in yargs", { args: ["serve", ...SIGNAL, "--allow", "x", "-t", "short"] });
back("serve with -t twice", "yargs makes an array of it", { args: ["serve", ...SIGNAL, "-t", "short", "-t", "short2"] });
back("serve -t help", "yargs's to answer", { args: ["serve", ...SIGNAL, "-t", "help"] });
back("serve with --port not a number", "not compared", { args: ["serve", ...SIGNAL, "--port", "abc", "-t", "short"] });
back("expose a port that is not a number", "not compared", { args: ["expose", "abc", ...SIGNAL, "-t", "short"] });
back("expose without a port", "yargs's to answer", { args: ["expose", ...SIGNAL, "-t", "short"] });
back("serve with a bad token and FORCE_COLOR", "console.error is coloured", { env: { FORCE_COLOR: "1" }, args: ["serve", ...SIGNAL, "-t", "short"] });
back("serve with a bad token beside a bunfig.toml", "bun reads it before the program", { files: { "bunfig.toml": "[install]\nexact = true\n" }, args: ["serve", ...SIGNAL, "-t", "short"] });

// ── dev with a live host daemon: registers and exits ─────────────────────────

const DEV_TOKEN = "Parity-Token-1";
const DAEMON_TOKEN = "Daemon Token/1+é";
/** daemon.json naming a process that is alive for the whole case: the
 *  runner itself, the parent of the shell that runs this line. */
const liveDaemon = (token = DAEMON_TOKEN, root = "/srv/ws") =>
  `mkdir -p <HOME>/.codehost && printf '{\\n  "pid": %s,\\n  "root": %s,\\n  "token": %s,\\n  "startedAt": 1\\n}' "$PPID" ${sq(JSON.stringify(root))} ${sq(JSON.stringify(token))} > <HOME>/.codehost/daemon.json`;
const DEV_AFTER = [HOME_STATE, GIT_LOG];
// Only the entry being added carries the time (13 digits until 2286); the
// entries already there keep shorter numbers, so they are compared.
const MS = [['"addedAt": \\d{13}', '"addedAt": <MS>']];
const dev = (name, { setup = [], args = [], ...rest } = {}) =>
  add(name, { liveDaemon: true, setup: [liveDaemon(), ...setup], args: ["dev", ...args, ...SIGNAL, "-t", DEV_TOKEN], after: DEV_AFTER, normalize: MS, ...rest });

dev("dev registers the current directory");
dev("dev registers a directory", { setup: ["mkdir ws"], args: ["ws"] });
dev("dev registers a directory that does not exist", { args: ["missing/dir"] });
dev("dev registers a directory with spaces and ü", { setup: ["mkdir 'my ws ü'"], args: ["my ws ü"] });
dev("dev registers a directory with a backslash", { setup: ["mkdir 'a\\b'"], args: ["a\\b"] });
dev("dev registers a repository", { setup: repo("r", { origin: "git@github.com:O/R.git", commit: true, branch: "feat/x" }), args: ["r"] });
dev("dev registers a repository without origin", { setup: repo("r"), args: ["r"] });
dev("dev registers with every option it takes", { args: [".", "--name", "x", "--port", "8080", "--approve", "confirm"] });
dev("dev registers next to other workspaces", {
  setup: [codehostFile("workspaces.json", '[\n  {\n    "path": "/a\\u00e9\\"q",\n    "addedAt": 5\n  },\n  {"addedAt": 170000000000, "path": "/b"}\n]')],
  args: ["ws"],
});
dev("dev registers into an empty list", { setup: [codehostFile("workspaces.json", "[]")] });
dev("dev with the directory registered already", { setup: ["mkdir ws", codehostFile("workspaces.json", '[{"path": "<CWD>/ws", "addedAt": 7}]')], args: ["ws"] });
add("dev with the daemon's own token", {
  liveDaemon: true,
  setup: [liveDaemon(DEV_TOKEN)],
  args: ["dev", ...SIGNAL, "-t", ` ${DEV_TOKEN} `],
  after: DEV_AFTER,
  normalize: MS,
});
add("dev with a daemon serving an odd root", {
  liveDaemon: true,
  setup: [liveDaemon(DAEMON_TOKEN, '/srv/"ws" ü')],
  args: ["dev", ...SIGNAL, "--token", DEV_TOKEN],
  after: DEV_AFTER,
  normalize: MS,
});
add("dev with a bad token and a live daemon", { setup: [liveDaemon()], args: ["dev", ...SIGNAL, "-t", "short"], after: DEV_AFTER });
back("dev with workspaces.json not JSON", "JSON.parse's verdict is not reproduced", {
  liveDaemon: true,
  setup: [liveDaemon(), codehostFile("workspaces.json", "not json")],
  args: ["dev", ...SIGNAL, "-t", DEV_TOKEN],
  after: DEV_AFTER,
  normalize: MS,
});
back("dev with an entry of workspaces.json the JavaScript keeps as it is", "the JavaScript rewrites what it read", {
  liveDaemon: true,
  setup: [liveDaemon(), codehostFile("workspaces.json", '[{"path": "/a", "addedAt": 1, "x": [1.50]}, 5]')],
  args: ["dev", ...SIGNAL, "-t", DEV_TOKEN],
  after: DEV_AFTER,
  normalize: MS,
});
back("dev with addedAt written as a float", "JavaScript's number formatting", {
  liveDaemon: true,
  setup: [liveDaemon(), codehostFile("workspaces.json", '[{"path": "/a", "addedAt": 1.7e12}]')],
  args: ["dev", ...SIGNAL, "-t", DEV_TOKEN],
  after: DEV_AFTER,
  normalize: MS,
});
back("dev with a daemon.json pid written as a float", "not compared", {
  liveDaemon: true,
  setup: ["mkdir -p <HOME>/.codehost && printf '{\"pid\": %s.0, \"root\": \"/r\", \"token\": \"t\"}' \"$PPID\" > <HOME>/.codehost/daemon.json"],
  args: ["dev", ...SIGNAL, "-t", DEV_TOKEN],
  after: DEV_AFTER,
  normalize: MS,
});

// ── the independent verifier's cases ─────────────────────────────────────────
//
// Written by the verifier of the first port (107 cases, named "verify: …"),
// to break it: files bun reads before the program, .env variables that reach
// git, very large values, the token policy at its edges, spellings, saved
// state. Taken over as they were, all 107, except: the two cases with a
// token the policy accepts also show that HOME stays empty (serve stops at
// `no workspace root configured` there); `expose 00000` gets the closed
// `--signal` every server case has; and the two cases for a
// repository of another user change its owner only where they can (as
// root), so that they run elsewhere too.

/** Every git command, each once: for a case the binary hands back after
 *  asking git, so that the JavaScript asks again. */
const GIT_ASKED = 'sort -u "$TMPDIR/git.log" 2>/dev/null || echo "(git not run)"';
const verify = (name, why, spec) => (why ? back(`verify: ${name}`, why, spec) : add(`verify: ${name}`, spec));
const vRepo = (origin, dir = ".") => repo(dir, { origin: origin ?? undefined });
const vCommit = (dir = ".") => `git -C ${sq(dir)} -c user.name=p -c user.email=p@p commit -q --allow-empty -m init`;
const vDaemon = (root = "/srv/ws", token = DAEMON_TOKEN) =>
  `mkdir -p <HOME>/.codehost && printf '{\\n  "pid": %s,\\n  "root": %s,\\n  "token": %s,\\n  "startedAt": 1\\n}' "$PPID" ${sq(JSON.stringify(root))} ${sq(JSON.stringify(token))} > <HOME>/.codehost/daemon.json`;
const vRawDaemon = (text) => `mkdir -p <HOME>/.codehost && printf '%s' ${sq(text)} > <HOME>/.codehost/daemon.json`;
const bigOrigin = (bytes) =>
  `printf '[remote "origin"]\\n\\turl = https://github.com/o/r/%s\\n' "$(head -c ${bytes} /dev/zero | tr '\\0' x)" >> .git/config`;
const vOpen = (name, why, args, extra = {}) => verify(name.startsWith("open") ? name : `open ${name}`, why, { args: ["open", ...args], after: OPEN_AFTER, ...extra });
const vDev = (name, why, args, setup, extra = {}) =>
  verify(name.startsWith("dev ") ? name : `dev ${name}`, why, {
    liveDaemon: true,
    args: ["dev", ...args, ...SIGNAL, "-t", DEV_TOKEN],
    setup,
    after: [HOME_STATE, GIT_LOG],
    normalize: MS,
    ...extra,
  });
const vInit = (name, why, args, extra = {}) => verify(`init ${name}`, why, { args: ["init", ...args], after: [CWD_STATE], ...extra });
const vServe = (name, why, token, extra = {}) => verify(name, why, { args: ["serve", ...SIGNAL, "-t", token], ...extra });
const WARNS = "bun warns about this project file";
const ENV_LOADED = "bun loads a variable from .env that is not set, and git inherits it";

// A. Project files bun reads before the program and warns about.
const PATHS_TWO_STARS_KEY = '{"compilerOptions": {"paths": {"a*b*": ["./x"]}}}';
const PATHS_TWO_STARS_TARGET = '{"compilerOptions": {"paths": {"@/*": ["./src/*/*"]}}}';
vOpen("open beside a tsconfig.json with a paths pattern of two stars", WARNS, ["--print", "--anon", "o/r"], { files: { "tsconfig.json": PATHS_TWO_STARS_KEY } });
vOpen("open beside a tsconfig.json with a paths target of two stars", WARNS, ["--print", "--anon", "o/r"], { files: { "tsconfig.json": PATHS_TWO_STARS_TARGET } });
vOpen("open beside a jsconfig.json with a paths target of two stars", WARNS, ["--print", "--anon", "o/r"], {
  files: { "jsconfig.json": '{"compilerOptions": {"paths": {"x/*": ["*/*"]}}}' },
});
vOpen("open beside a tsconfig.json with a jsxFactory bun cannot parse", WARNS, ["--print", "--anon", "o/r"], { files: { "tsconfig.json": '{"compilerOptions": {"jsxFactory": "a-b"}}' } });
vOpen("open beside a tsconfig.json with a jsxFragmentFactory bun cannot parse", WARNS, ["--print", "--anon", "o/r"], {
  files: { "tsconfig.json": '{"compilerOptions": {"jsxFragmentFactory": "a b"}}' },
});
vOpen("open below a tsconfig.json with paths bun warns about", WARNS, ["--print", "--anon", "o/r"], {
  files: { "tsconfig.json": PATHS_TWO_STARS_TARGET },
  setup: ["mkdir -p sub"],
  env: { PARITY_CD: "sub" },
});
vInit("beside a tsconfig.json with paths bun warns about", WARNS, ["ws"], { files: { "tsconfig.json": PATHS_TWO_STARS_KEY } });
vServe("serve with a bad token beside a tsconfig.json bun warns about", "bun's warnings are dropped by process.exit, but the file goes back all the same", "short", {
  files: { "tsconfig.json": PATHS_TWO_STARS_KEY },
});
vDev("dev registers beside a tsconfig.json bun warns about", WARNS, ["ws"], [vDaemon(), "mkdir ws"], { files: { "tsconfig.json": PATHS_TWO_STARS_KEY } });
vOpen("open beside a tsconfig.json with one-star paths and a member jsxFactory (bun is quiet)", null, ["--print", "--anon", "o/r"], {
  files: { "tsconfig.json": '{"compilerOptions": {"baseUrl": ".", "paths": {"*": ["*"], "@/*": ["./src/*"]}, "jsxFactory": "React.createElement"}}' },
});
vOpen("open beside a package.json with imports not starting with # (bun is quiet)", null, ["--print", "--anon", "o/r"], {
  files: { "package.json": '{"name": "x", "imports": {"a": "./x.js"}, "exports": {}}' },
});

// B. .env variables that reach git without GIT_ or XDG_ in their name.
vOpen("open in a repository beside a .env setting LD_LIBRARY_PATH to a libc git cannot load", ENV_LOADED, ["--print", "--anon"], {
  files: { ".env": "LD_LIBRARY_PATH=<CWD>/libs\n", "libs/libc.so.6": "not an ELF file\n" },
  setup: [...vRepo("https://github.com/o/r"), vCommit()],
});
vOpen("open in a repository of another user, with SUDO_UID in .env (needs root)", ENV_LOADED, ["--print", "--anon"], {
  files: { ".env": "SUDO_UID=65534\n" },
  setup: [...vRepo("https://github.com/o/r"), "chown -R 65534:65534 . 2>/dev/null || true"],
});
vOpen("open in a repository of another user, no .env (needs root)", null, ["--print", "--anon"], {
  setup: [...vRepo("https://github.com/o/r"), "chown -R 65534:65534 . 2>/dev/null || true"],
});
vOpen("open in a repository beside a .env setting LD_PRELOAD to nothing (git still runs)", ENV_LOADED, ["--print", "--anon"], {
  files: { ".env": "LD_PRELOAD=/nonexistent/libnothing.so\n" },
  setup: [...vRepo("https://github.com/o/r"), vCommit()],
});
vOpen("open beside a .env with export, quotes and expansion", ENV_LOADED, ["--print", "--anon", "o/r"], {
  files: { ".env": 'export FOO="a b"\nBAR=\'x\'\nBAZ=$FOO\nMULTI="1\n2"\n' },
});
vOpen("open in a repository beside a .env setting LANG and LC_ALL", ENV_LOADED, ["--print", "--anon"], {
  files: { ".env": "LANG=de_DE.UTF-8\nLC_ALL=de_DE.UTF-8\nLANGUAGE=de\n" },
  setup: [...vRepo("https://github.com/o/r"), vCommit()],
});
vOpen("open beside a .env.local that is a directory", "a .env that cannot be read goes back", ["--print", "--anon", "o/r"], { setup: ["mkdir .env.local"] });

// C. Very large values. bun's spawnSync stops at 1 MiB of a child's output.
vOpen("open in a repository whose origin URL is 9 MB", "git prints more than bun's spawnSync reads (1 MiB)", ["--print", "--anon"], {
  setup: [...vRepo(null), vCommit(), bigOrigin(9000000)],
  after: [GIT_ASKED, BROWSER_LOG],
});
vOpen("open in a repository whose origin URL is 600 KB", null, ["--print", "--anon"], { setup: [...vRepo(null), vCommit(), bigOrigin(600000)] });
vDev("dev registers a repository whose origin URL is 9 MB", "git prints more than bun's spawnSync reads (1 MiB)", ["r"], [vDaemon(), ...vRepo(null, "r"), `cd r && ${bigOrigin(9000000)}`], {
  after: [HOME_STATE, GIT_ASKED],
});
vOpen("open with a saved token of 200 KB", null, ["--print", "o/r"], {
  setup: [`mkdir -p <HOME>/.codehost && { printf '{"token": "'; head -c 200000 /dev/zero | tr '\\0' A; printf 'b1-/+"}'; } > <HOME>/.codehost/config.json`],
});
vServe("serve -t of 100 KB", null, "Aa1-".repeat(25000));

// D. The token policy.
vServe("serve -t of 11 UTF-16 units ending in astral characters", null, "Aa1-aaa😀😀");
vServe("serve -t of 257 units, the last character astral", null, `Aa1-${"a".repeat(251)}😀`);
// Two tokens the policy accepts. serve is the JavaScript's then, and with no
// dir in the runner's empty home it stops at `no workspace root configured`
// (see servesNoRoot); HOME is shown to stay empty.
const ACCEPTED = "a token the policy accepts: serve is the JavaScript's";
vServe("serve -t of 12 UTF-16 units, the last two one astral character (accepted)", ACCEPTED, "Aa1-aaaaaa😀", { noRoot: true, after: [HOME_STATE] });
vServe("serve -t with the Kelvin sign (accepted)", ACCEPTED, "Kodehost1234", { noRoot: true, after: [HOME_STATE] });
vServe("serve -t with U+180E (not \\s since ES2016)", null, "aaaa\u180eaaaaaaa");
vServe("serve -t with U+200B (not \\s)", null, "aaaaaaaaaaa\u200b");
vServe("serve -t with U+0085 (not \\s)", null, "aaaaaaaaaaa\u0085");
vServe("serve -t with U+2028 inside", null, "Aa1-aaaa\u2028aaaa");
vServe("serve -t weak, surrounded by NBSP", null, "\u00a0Changeme1234\u00a0");
vServe("serve -t PassWord1234", null, "PassWord1234");
vServe("serve -t of non-ASCII letters and digits", null, "ÄÖÜäöüß12345");
vServe("serve -t of 300 spaces", null, " ".repeat(300));
vServe("serve -t of a lone ideographic space and letters", null, "\u3000aaaaaaaaaaaaaa\u3000");
verify("expose 00000 with a bad token", null, { args: ["expose", "00000", ...SIGNAL, "-t", "short"] });
verify("dev --standalone with a bad token", null, { args: ["dev", "--standalone", ...SIGNAL, "-t", "short"] });
verify("serve --port 99999 with a bad token and a missing dir", null, {
  args: ["serve", "nowhere", "--port", "99999", ...SIGNAL, "-t", "short"],
  after: [CWD_STATE, HOME_STATE],
});
vServe("serve with a bad token and CLICOLOR_FORCE", null, "short", { env: { CLICOLOR_FORCE: "1" } });
vServe("serve with a bad token and FORCE_COLOR=0", "FORCE_COLOR is set", "short", { env: { FORCE_COLOR: "0" } });
vServe("serve with a bad token and TERM=dumb", null, "short", { env: { TERM: "dumb" } });
vServe("serve with a bad token and JSC_dumpOptions", null, "short", { env: { JSC_dumpOptions: "1" } });
vServe("serve with a bad token and an empty PATH entry", "an empty PATH entry", "short", { env: { PARITY_PATH_PREFIX: "/usr/bin:" } });

// E. Spellings of the command line.
const YARGS = "yargs's to answer";
vOpen('open "version --print"', null, ["version", "--print"]);
vOpen('"--print Help"', null, ["--print", "Help"]);
vOpen('"--print TRUE"', null, ["--print", "TRUE"]);
vOpen('"--print o/r --anon --anon"', "a repeated option is yargs's", ["--print", "o/r", "--anon", "--anon"]);
vOpen('"--print --page= o/r"', null, ["--print", "--page=", "o/r"]);
vOpen('"--print --page https://x.dev/?a=1/ o/r"', null, ["--print", "--page", "https://x.dev/?a=1/", "o/r"]);
vOpen('"--print -t 0x10 o/r"', null, ["--print", "-t", "0x10", "o/r"]);
vOpen('"--print -t =x o/r"', null, ["--print", "-t", "=x", "o/r"]);
vOpen("\"--print -t ' ' ''\" outside a repository", null, ["--print", "-t", " ", ""]);
vOpen('"--print completion"', null, ["--print", "completion"]);
vOpen('"--print --t x o/r"', "an unknown option", ["--print", "--t", "x", "o/r"]);
vOpen('"--print --page=help o/r"', null, ["--print", "--page=help", "o/r"]);
vOpen('"--print --token=true o/r"', null, ["--print", "--token=true", "o/r"]);
vOpen('"--print --page=false o/r"', null, ["--print", "--page=false", "o/r"]);
vOpen('"--print -t help o/r"', "the word help", ["--print", "-t", "help", "o/r"]);
vOpen('"--print o/r help"', "the word help", ["--print", "o/r", "help"]);
vOpen('"--print --anon" with an @-only target', null, ["--print", "--anon", "@"]);
vOpen('"--print --anon" with a target of newline-separated parts', null, ["--print", "--anon", "a/b\nc/d"]);
vOpen('"--print --anon" with a branch holding U+2028', null, ["--print", "--anon", "o/r/tree/a\u2028b"]);
vOpen('"--print --anon" with a CRLF-terminated target', null, ["--print", "--anon", "o/r\r\n"]);
vOpen('"--print --anon" with an http URL with a port and .git', null, ["--print", "--anon", "HTTP://Git.Example.com:8443/o/r.git?x#y"]);
verify('serve "--token=help"', null, { args: ["serve", ...SIGNAL, "--token=help"] });
vOpen('"--print -t" with a token holding a newline', null, ["--print", "-t", "a\nb", "o/r"]);
vOpen('"--print --page" ending in a space and a slash', null, ["--print", "--page", "https://x.dev/ /", "o/r"]);
vOpen("with a directory named git first on PATH", null, ["--print", "--anon"], {
  setup: [...vRepo("https://github.com/o/r"), "mkdir -p pp/git"],
  env: { PARITY_PATH_PREFIX: "<CWD>/pp" },
});
vOpen("with a git script without #! first on PATH", "a git that cannot be started", ["--print", "--anon"], {
  files: { "pp/git": 'case "$*" in *is-inside*) echo true;; *get-url*) echo https://github.com/o/r;; *) echo main;; esac\n' },
  setup: ["chmod +x pp/git"],
  env: { PARITY_PATH_PREFIX: "<CWD>/pp" },
});
verify('init "ws help"', "the word help", { args: ["init", "ws", "help"] });

// F. ~/.codehost/config.json.
const vConfig = (text) => codehostFile("config.json", text);
vOpen("open with a saved token of two spaces", null, ["--print", "o/r"], { setup: [vConfig('{"token": "  "}')] });
vOpen("open with a saved token holding U+2028 and an escaped pair", null, ["--print", "o/r"], { setup: [vConfig('{"token": "a\u2028b\\ud83d\\ude00"}')] });
vOpen("open with the key token written with an escape", null, ["--print", "o/r"], { setup: [vConfig('{"\\u0074oken": "Esc-Key-1"}')] });
vOpen("open with config.json a link to a file", null, ["--print", "o/r"], {
  setup: ["printf '%s' '{\"token\": \"Linked-1\"}' > real.json", "mkdir -p <HOME>/.codehost && ln -s <CWD>/real.json <HOME>/.codehost/config.json"],
});
vOpen("open with config.json in CRLF and nested values", null, ["--print", "o/r"], {
  setup: [vConfig('{\r\n  "hostId": {"a": [1, 2.5e3, null]},\r\n  "token": "Crlf-1"\r\n}\r\n')],
});
vOpen("open with config.json holding a NUL after the object", "text that is not strict JSON", ["--print", "o/r"], {
  setup: ["mkdir -p <HOME>/.codehost && printf '{\"token\": \"x\"}\\0' > <HOME>/.codehost/config.json"],
});
vOpen("open with HOME ending in a slash", null, ["--print", "o/r"], { env: { HOME: "<HOME>/" }, setup: [vConfig('{"token": "Slash-1"}')] });
vOpen("open with config.json holding an empty-string key and a token", null, ["--print", "o/r"], { setup: [vConfig('{"": 1, "token": "E-1"}')] });

// G. init.
vInit('"./"', null, ["./"]);
vInit('"ws/"', null, ["ws/"]);
vInit("with an empty config.yaml there", null, [], { files: { ".codehost/config.yaml": "" } });
vInit("a linked directory", null, ["link"], { setup: ["mkdir real && ln -s real link"] });
vInit("below a linked directory", null, ["link/sub"], { setup: ["mkdir real && ln -s real link"] });
vInit("-f with only setup.ps1 there", null, ["-f"], { files: { ".codehost/setup.ps1": "mine\n" } });
vInit("-f with setup.sh mode 700", null, ["-f"], { files: { ".codehost/setup.sh": "mine\n" }, setup: ["chmod 700 .codehost/setup.sh"] });
vInit('" ws "', null, [" ws "]);
vInit('"ws\\nx"', null, ["ws\nx"]);
vInit("into an empty .codehost", null, ["ws"], { setup: ["mkdir -p ws/.codehost"] });
vInit("a path through ..", null, ["a/../b/./c"]);
vInit("with setup.sh a FIFO", null, [], { setup: ["mkdir .codehost && mkfifo .codehost/setup.sh"] });

// H. dev registering with a live host daemon.
const vWorkspaces = (text) => codehostFile("workspaces.json", text);
vDev('dev ""', null, [""], [vDaemon()]);
vDev("with daemon.json in another key order with extra fields", null, ["ws"], [
  vRawDaemon('{"token": "Odd-Order-1", "extra": [1, {"x": null}], "root": "/r", "startedAt": 1.5, "pid": PID}').replace("PID", `'"$PPID"'`),
  "mkdir ws",
]);
vDev("with a daemon root holding a quote and a newline", null, ["ws"], [vDaemon('/srv/"w\ns"', "Daemon-Token-1"), "mkdir ws"]);
vDev("with a daemon token of #&? and spaces", null, ["ws"], [vDaemon("/srv/ws", "a #&?= b/%"), "mkdir ws"]);
vDev("with workspaces.json holding U+2028 and an escaped pair", null, ["ws"], [vDaemon(), vWorkspaces('[{"path": "/a\u2028b\\ud83d\\ude00\\u0001", "addedAt": 1}]'), "mkdir ws"]);
vDev("with workspaces.json addedAt first", null, ["ws"], [vDaemon(), vWorkspaces('[{"addedAt": 9007199254740991, "path": "/x"}]'), "mkdir ws"]);
vDev("with the directory registered already, written with escapes", null, ["ws"], [vDaemon(), vWorkspaces('[{"path": "<CWD>\\/ws", "addedAt": 1}]'), "mkdir ws"]);
vDev("with workspaces.json a link to a file", null, ["ws"], [vDaemon(), "printf '[]' > <CWD>/w.json && ln -s <CWD>/w.json <HOME>/.codehost/workspaces.json", "mkdir ws"], {
  after: [HOME_STATE, "cat <CWD>/w.json; echo", GIT_LOG],
});
vDev("in a repository without origin on a branch", null, ["r"], [vDaemon(), ...vRepo(null, "r"), vCommit("r")]);
vDev("registers a directory named with a trailing dot segment", null, ["ws/."], [vDaemon(), "mkdir ws"]);
vDev("registers a directory given with ..", null, ["ws/../ws2"], [vDaemon(), "mkdir ws ws2"]);
vDev("with daemon.json pid 0", "a pid that is not a positive integer", ["ws"], [vRawDaemon('{"pid": 0, "root": "/r", "token": "Zero-Pid-1"}'), "mkdir ws"]);
vDev("with workspaces.json [] and spaces", null, ["ws"], [vDaemon(), vWorkspaces(" [ ] \n"), "mkdir ws"]);
vDev("with an entry for the directory that has a third key", "an entry the JavaScript keeps by its own rules", ["ws"], [
  vDaemon(),
  vWorkspaces('[{"path": "<CWD>/ws", "addedAt": 1, "x": 2}]'),
  "mkdir ws",
]);
vDev("with daemon.json root and token not strings", "root and token are not strings", ["ws"], [
  vRawDaemon('{"pid": PID, "root": 5, "token": ["a"]}').replace("PID", `'"$PPID"'`),
  "mkdir ws",
]);
vDev("registers a repository with an upper-case scheme and port", null, ["r"], [vDaemon(), ...vRepo("SSH://git@Git.Example.com:2222/team/svc.GIT/", "r"), vCommit("r")]);

// ── the repairs after the verification ───────────────────────────────────────
//
// Each pins one rule added for the verifier's findings, on both sides of it.

// Project files: bun's other `paths` warning, and the edges of jsxFactory.
back("repair: open beside a tsconfig.json with a paths target not relative and no baseUrl", WARNS, {
  files: { "tsconfig.json": '{"compilerOptions": {"paths": {"@/*": ["src/*"]}}}' },
  args: ["open", "--print", "--anon", "o/r"],
});
add("repair: open beside a tsconfig.json with a paths target not relative and a baseUrl", {
  files: { "tsconfig.json": '{"compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["src/*", "./lib/*"]}}}' },
  args: ["open", "--print", "--anon", "o/r"],
});
back("repair: open beside a jsconfig.json with a jsxFactory ending in a dot", WARNS, {
  files: { "jsconfig.json": '{"compilerOptions": {"jsxFactory": "a."}}' },
  args: ["open", "--print", "--anon", "o/r"],
});
add("repair: open beside a tsconfig.json with member jsxFactory and jsxFragmentFactory", {
  files: { "tsconfig.json": '{"compilerOptions": {"jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Preact.Fragment"}}' },
  args: ["open", "--print", "--anon", "o/r"],
});

// .env: native only when every key it could define is set already.
add("repair: open in a repository beside a .env whose keys are all set already", {
  files: { ".env": "# set by the case\nCODEHOST_PARITY_SET=from the file\nexport HOME=/elsewhere\n\n" },
  env: { CODEHOST_PARITY_SET: "from the environment" },
  setup: [...vRepo("https://github.com/o/r"), vCommit()],
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
add("repair: open beside a .env of comments and blank lines", { files: { ".env": "# nothing here\n\n   \n# see the README\n" }, args: ["open", "--print", "--anon", "o/r"] });
// A key inside a comment is taken as well: a name too many only hands back.
back("repair: open beside a .env with a key only in a comment", "the binary takes every name bun could take, comments included", {
  files: { ".env": "# CODEHOST_PARITY_NEW=1\n" },
  args: ["open", "--print", "--anon", "o/r"],
});
back("repair: open beside a .env setting a variable that is set but empty", ENV_LOADED, {
  files: { ".env": "CODEHOST_PARITY_EMPTY=x\n" },
  env: { CODEHOST_PARITY_EMPTY: "" },
  args: ["open", "--print", "--anon", "o/r"],
});
back("repair: open in a repository beside a .env setting a variable git does not read", ENV_LOADED, {
  files: { ".env": "CODEHOST_PARITY_NEW=1\n" },
  setup: [...vRepo("https://github.com/o/r"), vCommit()],
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
back("repair: open beside a .env with a key after a quoted value", ENV_LOADED, { files: { ".env": 'HOME="/x" CODEHOST_PARITY_NEW=1\n' }, args: ["open", "--print", "--anon", "o/r"] });
back("repair: open beside a .env with a key written KEY: value", ENV_LOADED, { files: { ".env": "CODEHOST_PARITY_NEW: 1\n" }, args: ["open", "--print", "--anon", "o/r"] });
// bun skips line ends between a key and its `=` as it skips blanks: the
// first repair missed these, and the TypeScript's git then could not start.
back("repair: open in a repository beside a .env setting LD_LIBRARY_PATH with a CR before =", ENV_LOADED, {
  files: { ".env": "LD_LIBRARY_PATH\r=<CWD>/libs\n", "libs/libc.so.6": "not an ELF file\n" },
  setup: [...vRepo("https://github.com/o/r"), vCommit()],
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
back("repair: open beside a .env with a key on one line and its = on the next", ENV_LOADED, {
  files: { ".env": "CODEHOST_PARITY_NEW\n=1\n" },
  args: ["open", "--print", "--anon", "o/r"],
});
add("repair: open in a repository beside a .env whose keys, all set already, end in line ends before =", {
  files: { ".env": "HOME\r=/elsewhere\nCODEHOST_PARITY_SET\n=from the file\n" },
  env: { CODEHOST_PARITY_SET: "from the environment" },
  setup: [...vRepo("https://github.com/o/r"), vCommit()],
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
back("repair: open with LD_BIND_NOW set", "the dynamic loader that starts bun reads LD_*", { env: { LD_BIND_NOW: "1" }, args: ["open", "--print", "--anon", "o/r"] });

// git's output at bun's spawnSync limit: 1,048,576 bytes is read, more is not.
add("repair: open in a repository whose origin URL makes git print exactly 1 MiB", {
  // "https://github.com/o/r/" (23 bytes), the x's, and git's newline.
  setup: [...vRepo(null), bigOrigin(1024 * 1024 - 24)],
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
back("repair: open with a git that writes 9 MB to stderr", "git prints more than bun's spawnSync reads (1 MiB)", {
  files: {
    "pp/git": '#!/bin/sh\nPATH=${PATH#*:}; export PATH\nout=$(git "$@"); status=$?\nhead -c 9000000 /dev/zero | tr \'\\0\' x >&2\nprintf \'%s\\n\' "$out"\nexit $status\n',
  },
  setup: [...vRepo("https://github.com/o/r"), "chmod +x pp/git"],
  env: { PARITY_PATH_PREFIX: "<CWD>/pp" },
  args: ["open", "--print", "--anon"],
  after: [GIT_ASKED, BROWSER_LOG],
});

// HOME as the TypeScript reads it: path.join(homedir(), ".codehost", …)
// resolves a `..` by the text, the system through the directories. Found
// after the verification (the first repair answered both `..` cases with
// the file the system names: no token, or another one).
const HOME_DOTDOT = "a HOME with a `..` component, which path.join resolves by the text";
const homeConfig = (dir, token) => `mkdir -p ${dir}/.codehost && printf '{"token": "${token}"}' > ${dir}/.codehost/config.json`;
back("repair: open with HOME through a missing directory and ..", HOME_DOTDOT, {
  env: { HOME: "<CWD>/nope/../h" },
  setup: [homeConfig("h", "Saved-1")],
  args: ["open", "--print", "o/r"],
});
back("repair: open with HOME through a link and ..", HOME_DOTDOT, {
  env: { HOME: "<CWD>/ln/../h" },
  setup: ["mkdir -p p/q && ln -s <CWD>/p/q ln", homeConfig("h", "Saved-1"), homeConfig("p/h", "Other-2")],
  args: ["open", "--print", "o/r"],
});
add("repair: open with a relative HOME", { env: { HOME: "h" }, setup: [homeConfig("h", "Saved-1")], args: ["open", "--print", "o/r"] });
add("repair: open with HOME holding a . segment and a double slash", {
  env: { HOME: "<CWD>/./h//" },
  setup: [homeConfig("h", "Saved-1")],
  args: ["open", "--print", "o/r"],
});
const homeDaemon = (dir) =>
  `mkdir -p ${dir}/.codehost && printf '{\\n  "pid": %s,\\n  "root": "/srv/ws",\\n  "token": "Daemon-Token-1"\\n}' "$PPID" > ${dir}/.codehost/daemon.json`;
back("repair: dev registers with HOME through a missing directory and ..", HOME_DOTDOT, {
  liveDaemon: true,
  env: { HOME: "<CWD>/nope/../h" },
  setup: [homeDaemon("h"), "mkdir ws"],
  args: ["dev", "ws", ...SIGNAL, "-t", DEV_TOKEN],
  after: [CWD_STATE, GIT_ASKED],
  normalize: MS,
});
add("repair: dev registers with a relative HOME", {
  liveDaemon: true,
  env: { HOME: "h" },
  setup: [homeDaemon("h"), "mkdir ws"],
  args: ["dev", "ws", ...SIGNAL, "-t", DEV_TOKEN],
  after: [CWD_STATE, GIT_LOG],
  normalize: MS,
});

// A variable that is not UTF-8: bun's process.env holds text, and the git it
// starts gets U+FFFD in place of the bytes. Found after the verification
// (the first repair answered with the git config that the TypeScript's git
// could not find). rs/parity/run.sh sets the variable (PARITY_PRINTF_ENV).
const NOT_TEXT = "a variable that is not UTF-8, which bun hands to git changed";
back("repair: open in a repository with XDG_CONFIG_HOME not UTF-8, whose git config rewrites the origin", NOT_TEXT, {
  env: { PARITY_PRINTF_ENV: "XDG_CONFIG_HOME=<CWD>/cfg\\377" },
  setup: [
    `mkdir -p "$(printf 'cfg\\377/git')" && printf '[url "https://github.com/"]\\n\\tinsteadOf = gh:\\n' > "$(printf 'cfg\\377/git/config')"`,
    ...vRepo("gh:o/r"),
    vCommit(),
  ],
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
add("repair: open in a repository with XDG_CONFIG_HOME whose git config rewrites the origin", {
  env: { XDG_CONFIG_HOME: "<CWD>/cfg" },
  setup: [`mkdir -p cfg/git && printf '[url "https://github.com/"]\\n\\tinsteadOf = gh:\\n' > cfg/git/config`, ...vRepo("gh:o/r"), vCommit()],
  args: ["open", "--print", "--anon"],
  after: OPEN_AFTER,
});
back("repair: open with a variable git does not read, not UTF-8", NOT_TEXT, {
  env: { PARITY_PRINTF_ENV: "CODEHOST_PARITY_RAW=a\\377b" },
  args: ["open", "--print", "--anon", "o/r"],
});

// ── write ────────────────────────────────────────────────────────────────────

const names = new Set();
for (const c of cases) {
  if (names.has(c.name)) throw new Error(`two cases named ${c.name}`);
  names.add(c.name);
}
const spec = {
  env: {
    // Neither is read on a path the binary answers; both keep a wrong case
    // from reaching anything: no self-update, no VS Code.
    CODEHOST_NO_SELF_UPDATE: "1",
    CODEHOST_CODE_BIN: "/nonexistent/code",
  },
  cases,
};
const json = `${JSON.stringify(spec, null, 2)}\n`;
if (process.argv.includes("--list")) {
  for (const c of cases) console.log(`${c.handback ? "back" : "add "}  ${c.name}`);
} else if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== json) {
    console.error("rs/parity.json is not what rs/parity.gen.mjs writes; run: node rs/parity.gen.mjs");
    process.exit(1);
  }
  console.log(`rs/parity.json is up to date (${cases.length} cases)`);
} else {
  fs.writeFileSync(OUT, json);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${cases.length} cases, ${cases.filter((c) => c.handback).length} handed back)`);
}
