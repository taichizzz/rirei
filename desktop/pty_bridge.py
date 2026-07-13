#!/usr/bin/python3
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def parse_size(value, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if 1 <= parsed <= 10000 else fallback


def set_winsize(master, rows, cols):
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def control_fd_open():
    # The renderer sends resize messages on fd 3 when the app provides it.
    try:
        os.fstat(3)
    except OSError:
        return None
    return 3


def main() -> int:
    if len(sys.argv) < 2:
        return 2

    rows = parse_size(os.environ.get('RELAY_ROWS'), 24)
    cols = parse_size(os.environ.get('RELAY_COLS'), 80)

    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    set_winsize(master, rows, cols)

    def forward_signal(signum, _frame):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    control = control_fd_open()
    control_buffer = b''

    inputs = [master, stdin]
    if control is not None:
        inputs.append(control)

    while True:
        readable, _, _ = select.select(inputs, [], [])
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            stdout.write(data)
            stdout.flush()
        if stdin in readable:
            data = stdin.read1(65536)
            if not data:
                inputs.remove(stdin)
            else:
                os.write(master, data)
        if control is not None and control in readable:
            chunk = os.read(control, 65536)
            if not chunk:
                inputs.remove(control)
                control = None
            else:
                control_buffer += chunk
                while b'\n' in control_buffer:
                    line, control_buffer = control_buffer.split(b'\n', 1)
                    if not line.strip():
                        continue
                    try:
                        message = json.loads(line)
                        set_winsize(
                            master,
                            parse_size(message.get('rows'), rows),
                            parse_size(message.get('cols'), cols),
                        )
                    except (ValueError, TypeError):
                        pass

    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == '__main__':
    raise SystemExit(main())
