// Prints what is below a directory, for an `after` line of rs/parity.json:
//
//   node rs/parity/tree.mjs <dir>
//
// First one line per entry, `<kind> <mode> ./<path>`, sorted by their bytes:
// the kind as GNU find's %y writes it (f, d, l, p, s, b, c), the permission
// bits in octal as its %m does. Then every regular file (not a link to one),
// in the order of its path: `== ./<path>`, its bytes as they are, a line end.
// This is what `find . -mindepth 1 -printf '%y %m %p\n' | sort` and a `cat`
// of each file printed on Linux; BSD find on macOS has no -printf, and node
// (or bun) is on every machine the cases run on. Names are handled as bytes,
// so a name that is not UTF-8 is printed as it is.
//
// Run it from a directory of the test's own (<ROOT>): bun, which may stand
// in for node, reads .env, bunfig.toml and package.json where it is started.

import fs from "node:fs";

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: tree.mjs <dir>\n");
  process.exit(2);
}

const text = (value) => Buffer.from(value, "utf8");
const under = (relative) => Buffer.concat([text(`${dir}/`), relative]);

function kind(stat) {
  if (stat.isSymbolicLink()) return "l";
  if (stat.isDirectory()) return "d";
  if (stat.isFile()) return "f";
  if (stat.isFIFO()) return "p";
  if (stat.isSocket()) return "s";
  if (stat.isBlockDevice()) return "b";
  if (stat.isCharacterDevice()) return "c";
  return "?";
}

const entries = [];
const problems = [];
function walk(relative) {
  let names;
  try {
    names = fs.readdirSync(relative.length ? under(relative) : text(dir), { encoding: "buffer" });
  } catch (error) {
    problems.push(Buffer.concat([text("cannot list ./"), relative, text(`: ${error.code}`)]));
    return;
  }
  for (const name of names) {
    const entry = relative.length ? Buffer.concat([relative, text("/"), name]) : name;
    const stat = fs.lstatSync(under(entry));
    const shown = Buffer.concat([text("./"), entry]);
    entries.push({ shown, entry, kind: kind(stat), line: Buffer.concat([text(`${kind(stat)} ${(stat.mode & 0o7777).toString(8)} `), shown]) });
    if (stat.isDirectory()) walk(entry);
  }
}
walk(Buffer.alloc(0));

const out = [];
for (const line of [...entries.map((entry) => entry.line).sort(Buffer.compare), ...problems]) out.push(line, text("\n"));
for (const file of entries.filter((entry) => entry.kind === "f").sort((a, b) => Buffer.compare(a.shown, b.shown))) {
  out.push(text("== "), file.shown, text("\n"));
  try {
    out.push(fs.readFileSync(under(file.entry)));
  } catch (error) {
    out.push(text(`(cannot read: ${error.code})`));
  }
  out.push(text("\n"));
}
process.stdout.write(Buffer.concat(out));
