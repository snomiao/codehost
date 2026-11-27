#!/bin/sh
# Everything that shows the binary behaves like the TypeScript, in one go:
#
#   sh rs/parity/proof.sh <rustify's templates/parity/parity.mjs> <the codehost binary>
#
# from anywhere, after `bun install` in the repository (node-datachannel's
# install script fetches its prebuilt addon, which every command loads). The
# CI workflow runs this against the Linux binary it has just built.
#
#   1. rs/parity.json is what rs/parity.gen.mjs writes;
#   2. every case, TypeScript (`bun src/cli/index.ts`) against the binary,
#      both behind rs/parity/run.sh;
#   2b. the same with a pseudo-terminal as standard input, output and error
#      (rs/parity/terminal.py): there bun prints console.error in red, and
#      the binary hands back what writes to standard error. The hand-back
#      check below is not repeated on a terminal, where those cases go back;
#   3. the binary alone against the runner's stand-in package, which fails
#      unless exactly the cases marked "handback" reach the JavaScript. The
#      binary hands back when node-datachannel's addon is not where
#      `require` would find it, so a stub of that package is put in the
#      directory the runner makes its stand-in in (its TMPDIR);
#   4. `cargo test`: the unit tests, and the comparison of the helpers with
#      the TypeScript's own functions run by bun (rs/src/compare.rs). This
#      builds the crate again from the same sources and Cargo.lock.
#
# Each run gets a temp directory of its own, removed afterwards.
set -u
usage="usage: proof.sh <parity.mjs> <binary>"
absolute() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}
runner=$(absolute "${1:?$usage}")
binary=$(absolute "${2:?$usage}")
cd "$(dirname "$0")/../.." || exit 1
repo=$PWD

node rs/parity.gen.mjs --check || exit 1

failed=0
plain=$(mktemp -d)
TMPDIR=$plain node "$runner" --cases rs/parity.json \
  --ts "sh rs/parity/run.sh bun src/cli/index.ts" \
  --rs "env CODEHOST_PACKAGE_ROOT=$repo sh rs/parity/run.sh $binary" || failed=1
rm -rf "$plain"

terminal=$(mktemp -d)
TMPDIR=$terminal node "$runner" --cases rs/parity.json \
  --ts "python3 rs/parity/terminal.py sh rs/parity/run.sh bun src/cli/index.ts" \
  --rs "env CODEHOST_PACKAGE_ROOT=$repo python3 rs/parity/terminal.py sh rs/parity/run.sh $binary" || failed=1
rm -rf "$terminal"

handback=$(mktemp -d)
stub="$handback/node_modules/node-datachannel"
mkdir -p "$stub/build/Release"
printf '{"name": "node-datachannel"}\n' > "$stub/package.json"
: > "$stub/build/Release/node_datachannel.node"
TMPDIR=$handback node "$runner" --cases rs/parity.json \
  --rs "sh rs/parity/run.sh $binary" \
  --handback CODEHOST_PACKAGE_ROOT=src/cli/index.ts || failed=1
rm -rf "$handback"

cargo test --locked --manifest-path rs/Cargo.toml || failed=1
exit $failed
