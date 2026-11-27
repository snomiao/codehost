#!/usr/bin/env python3
"""Runs a command with a terminal as its standard input, output and error.

    python3 rs/parity/terminal.py <command> [args...]

On a terminal bun prints console.error in red, and the parity runner has no
terminal. Put in front of both implementations, this gives each a
pseudo-terminal of its own and passes on what was written to it, byte for
byte (standard output and error together, line ends as CR LF, as a terminal
gets them), and the command's exit code.

It ends when the command has ended and what it wrote has been passed on, not
when the last holder of the terminal closes it: pty.spawn waits for the
latter, which never came on macOS (python 3.9 there waited until killed in
every case). What a process the command left behind writes later is not
passed on. Linux and macOS; Windows has no pseudo-terminal for it.
"""

import os
import pty
import select
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(sys.argv[1], sys.argv[1:])
        except OSError as error:
            os.write(2, f"terminal.py: cannot run {sys.argv[1]}: {error.strerror}\n".encode())
        os._exit(127)

    stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
    watched = [master, stdin]
    status = None
    while True:
        if status is None:
            ended, code = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = code
        # Once the command has ended, everything it wrote is already in the
        # terminal: take what is there, without waiting for more.
        readable, _, _ = select.select(watched, [], [], 0 if status is not None else 0.05)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:  # Linux: EIO once nothing holds the terminal
                data = b""
            if not data:
                break
            while data:
                data = data[os.write(stdout, data):]
            continue
        if stdin in readable:
            data = os.read(stdin, 65536)
            if data:
                os.write(master, data)
            else:
                watched.remove(stdin)
            continue
        if status is not None:
            break
    if status is None:
        _, status = os.waitpid(pid, 0)
    os.close(master)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
