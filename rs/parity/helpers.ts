// The TypeScript side of rs/src/compare.rs: reads a JSON object of inputs on
// standard input and prints what the TypeScript's own functions answer for
// each, as JSON. Run by `cargo test`; it reads no file of the machine (HOME
// is a throwaway directory, and no call below reads the saved token).
//
// `buildUrl` is private to src/cli/commands/open.ts, so that file is loaded
// as it is, with its relative imports made absolute and an export added.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const { gitUrlToPath, shareableDeepLink, toPosixPath } = await import(join(root, "src/shared/repo.ts"));
const { parseGitRemote } = await import(join(root, "src/cli/git.ts"));
const { validateToken } = await import(join(root, "src/shared/token.ts"));

const imports: Record<string, string> = {
  "../config": "src/cli/config.ts",
  "../git": "src/cli/git.ts",
  "../open-url": "src/cli/open-url.ts",
  "../../shared/repo": "src/shared/repo.ts",
};
let source = readFileSync(join(root, "src/cli/commands/open.ts"), "utf8");
for (const [from, to] of Object.entries(imports)) {
  source = source.split(`from "${from}"`).join(`from ${JSON.stringify(join(root, to))}`);
}
if (/from "\.\.?\//.test(source)) throw new Error("open.ts has an import this script does not know");
const dir = mkdtempSync(join(tmpdir(), "codehost-compare-"));
writeFileSync(join(dir, "open.ts"), `${source}\nexport { buildUrl };\n`);
const { buildUrl } = await import(join(dir, "open.ts"));
rmSync(dir, { recursive: true, force: true });

// The yargs chain of src/cli/index.ts, with every handler replaced by one
// that only records what it was given: nothing runs. `.parse` with a callback
// prints nothing and exits nowhere; help, the version and errors come back
// as output or a failure.
const commands = await Promise.all(
  [
    ["setup", "setupCommand"],
    ["init", "initCommand"],
    ["serve", "serveCommand"],
    ["dev", "devCommand"],
    ["expose", "exposeCommand"],
    ["open", "openCommand"],
    ["list", "listCommand"],
    ["stop", "stopCommand"],
    ["update", "updateCommand"],
    ["supervise", "superviseCommand"],
  ].map(async ([file, name]) => (await import(join(root, `src/cli/commands/${file}.ts`)))[name]),
);
const { default: yargs } = await import(join(root, "node_modules/yargs/index.mjs"));
const show = (value: unknown) => (value === undefined ? "<none>" : String(value));
function describe(command: string, argv: Record<string, unknown>): string {
  switch (command) {
    case "open":
      return ["open", show(argv.target), show(argv.token), show(argv.anon), show(argv.page)].join("\u0001");
    case "init":
      return ["init", show(argv.dir), show(argv.force)].join("\u0001");
    case "serve":
      return ["serve", show(argv.token), show(argv.dir)].join("\u0001");
    case "dev":
      return ["dev", show(argv.token), show(argv.dir), show(argv.standalone)].join("\u0001");
    case "expose":
      return ["expose", show(argv.token)].join("\u0001");
    default:
      return `other ${command}`;
  }
}
function parseLine(line: string[]): string | null {
  let seen: string | null = null;
  let failed = false;
  let printed = "";
  const chain = yargs(line)
    .scriptName("codehost")
    .usage("$0 <command> [options]")
    .exitProcess(false)
    .fail(() => {
      failed = true;
    });
  for (const command of commands) {
    const name = String(command.command).split(" ")[0];
    chain.command({ ...command, handler: (argv: Record<string, unknown>) => void (seen = describe(name, argv)) });
  }
  try {
    chain.demandCommand(1, "Specify a command, e.g. `codehost serve`").strict().help().alias("h", "help").version();
    chain.parse(line, {}, (_err: unknown, _argv: unknown, output: string) => void (printed = output ?? ""));
  } catch {
    failed = true;
  }
  return failed || printed !== "" ? null : seen;
}

const input = JSON.parse(readFileSync(0, "utf8"));
const answers = {
  gitUrlToPath: input.urls.map((url: string) => gitUrlToPath(url)),
  parseGitRemote: input.urls.map((url: string) => parseGitRemote(url) ?? null),
  toPosixPath: input.urls.map((path: string) => toPosixPath(path)),
  folderLink: input.folders.map(([folder, host]: [string, string]) => shareableDeepLink({ folder, host })),
  reason: input.texts.map((token: string) => validateToken(token.trim()).reason ?? null),
  trim: input.texts.map((text: string) => text.trim()),
  encoded: input.texts.map((text: string) => encodeURIComponent(text)),
  length: input.texts.map((text: string) => text.length),
  buildUrl: input.targets.map(([target, token, page]: [string, string | null, string]) =>
    buildUrl({ target, token: token ?? undefined, anon: token === null, page, print: true }),
  ),
  parsed: (input.lines ?? []).map((line: string[]) => parseLine(line)),
};
process.stdout.write(JSON.stringify(answers));
