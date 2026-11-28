#!/usr/bin/env python3
"""Runs a command with a terminal as its standard input, output and error.

    python3 rs/parity/terminal.py <command> [args...]

On a terminal bun prints console.error in red, and the parity runner has no
terminal. Put in front of both implementations, this gives each a
pseudo-terminal of its own and passes on what was written to it, byte for
byte (standard output and error together, line ends as CR LF, as a terminal
gets them), and the command's exit code.

It keeps a handle on the terminal of its own until the command has ended
and what it wrote has been passed on, and ends then: not when the last
holder of the terminal closes it, which pty.spawn waits for and which never
came on macOS (python 3.9 there waited until killed in every case). What a
process the command left behind writes later is not passed on.

The handle matters on macOS. There the last close of a terminal waits at
most 0.6 s for the other end to read what is still in it, and then throws it
away (60 ticks: ptsclose in XNU). With pty.fork this process had let go of
the terminal, so the command's exit was that last close: a command that
printed and ended at once lost all of its output whenever this process did
not get to read within 0.6 s, as on a busy CI runner (measured on macOS 27:
with this process stopped for 1.5 s, 0 of 8 runs kept the output; with the
handle held, 8 of 8). bash, which macOS's sh is, avoids it by opening
/dev/tty when it starts; the binary and bun started without sh do not.
proof.sh puts `sh rs/parity/run.sh` behind this on both sides, so that
protected them already; the handle makes this independent of it. Linux
keeps the output either way. Linux and macOS; Windows has no
pseudo-terminal for it.
"""

import fcntl
import os
import pty
import select
import sys
import termios


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    master, slave = pty.openpty()
    pid = os.fork()
    if pid == 0:
        # What pty.fork does in the child: a session of its own, with the
        # terminal as its controlling terminal and its standard streams.
        try:
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
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
            except OSError:
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
    os.close(slave)
    os.close(master)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
