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
//     workspaces.json); and never with -d, --standalone or without
//     `--signal ws://127.0.0.1:1`. If a case were wrong, the TypeScript
//     would find no VS Code (CODEHOST_CODE_BIN points nowhere) and no
//     signaling server;
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
    if (rest.some((a) => ["-d", "--daemon", "--standalone"].includes(a) || a.startsWith("--daemon") || a.startsWith("--standalone"))) {
      throw new Error(`${c.name}: no -d or --standalone`);
    }
    const accepted = tokensIn(rest).some(policyAccepts);
    if (accepted && !(command === "dev" && c.liveDaemon)) throw new Error(`${c.name}: a token the policy accepts would start a server`);
  }
}

// ── cases ────────────────────────────────────────────────────────────────────

const cases = [];
function add(name, spec) {
  const c = { name, ...spec };
  refuseDanger(c);
  const { liveDaemon, ...kept } = c;
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
add("open beside a .env without anything that matters", { files: { ".env": "FOO=1\nGITHUB_TOKEN=not-a-real-one\n" }, args: ["open", "--print", "--anon", "o/r"] });
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
