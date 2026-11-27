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
};
process.stdout.write(JSON.stringify(answers));
