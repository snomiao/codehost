#!/bin/sh
# Runs one implementation for a parity case:
#
#   sh rs/parity/run.sh <command> [args...]
#
# in front of both (`bun src/cli/index.ts` and the binary). In the case's own
# temp directory ($TMPDIR, which the runner makes for every run) it puts
# stand-ins first on PATH:
#
#   git              writes its arguments to $TMPDIR/git.log and runs the
#                    real git, so that a case can compare what each
#                    implementation asked git
#   xdg-open, open   write to $TMPDIR/browser.log and do nothing: no case
#                    means to open a browser, and the cases of `open` print
#                    that log to show none was asked to
#
# These variables of the case steer it, and are not passed on:
#
#   PARITY_CD=<dir>    start the command in that directory below the case's
#                      directory (which the runner cannot choose)
#   PARITY_NO_GIT=1    no git at all: PATH holds only a link to bun
#   PARITY_PATH_PREFIX=<dir>  put <dir> (relative, say) first on PATH
#   PARITY_PRINTF_ENV=<name>=<format>  set <name> to what printf makes of
#                      <format>: a value that is not UTF-8 (`\377`), which
#                      the cases file, being JSON, cannot hold
#
# On Windows (Git Bash) the runner writes TMPDIR as C:/…, while PATH there is
# a list of POSIX paths, so the stand-ins' directory goes on it as /c/….
# There the runtime looks programs up with PATHEXT and never runs the git
# stand-in, a shell script, so the cases show no git commands on Windows
# (where the binary answers nothing natively).
set -eu

shims="$TMPDIR/shims"
mkdir -p "$shims"
shims_on_path=$shims
windows=
if command -v cygpath > /dev/null 2>&1; then
  windows=1
  shims_on_path=$(cygpath -u "$shims")
fi
for opener in xdg-open open; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/browser.log"\n' "$opener" "$TMPDIR" > "$shims/$opener"
  chmod +x "$shims/$opener"
done

if [ "${PARITY_NO_GIT:-}" = 1 ]; then
  bun=$(command -v bun)
  if [ -n "$windows" ]; then
    # A Windows program finds bun only as bun.exe, and Git Bash's ln -s
    # would copy it: a hard link, or a copy where that cannot be made.
    case $bun in *.exe) ;; *) bun=$bun.exe ;; esac
    ln "$bun" "$shims/bun.exe" 2> /dev/null || cp "$bun" "$shims/bun.exe"
  else
    ln -s "$bun" "$shims/bun"
  fi
  PATH="$shims_on_path"
else
  real_git=$(command -v git)
  cat > "$shims/git" << EOF
#!/bin/sh
printf 'git %s\n' "\$*" >> "$TMPDIR/git.log"
exec "$real_git" "\$@"
EOF
  chmod +x "$shims/git"
  PATH="$shims_on_path:$PATH"
fi
if [ -n "${PARITY_PATH_PREFIX:-}" ]; then
  PATH="$PARITY_PATH_PREFIX:$PATH"
fi
export PATH
unset PARITY_NO_GIT PARITY_PATH_PREFIX

if [ -n "${PARITY_PRINTF_ENV:-}" ]; then
  name=${PARITY_PRINTF_ENV%%=*}
  value=$(printf "${PARITY_PRINTF_ENV#*=}")
  export "$name=$value"
fi
unset PARITY_PRINTF_ENV

if [ -n "${PARITY_CD:-}" ]; then
  cd "$PARITY_CD"
fi
unset PARITY_CD

exec "$@"
