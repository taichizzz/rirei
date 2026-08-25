#!/usr/bin/python3
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import uuid


PROTOCOL_VERSION = 1


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
    try:
        os.fstat(3)
    except OSError:
        return None
    return 3


def event_fd_open():
    try:
        os.fstat(4)
    except OSError:
        return None
    return 4


def main() -> int:
    if len(sys.argv) < 2:
        return 2

    rows = parse_size(os.environ.get('RELAY_ROWS'), 24)
    cols = parse_size(os.environ.get('RELAY_COLS'), 80)

    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    set_winsize(master, rows, cols)

    def process_children():
        try:
            rows = subprocess.check_output(
                ['ps', '-axo', 'pid=,ppid='], text=True
            ).splitlines()
            children = {}
            for row in rows:
                process_id, parent_id = (int(value) for value in row.split())
                children.setdefault(parent_id, []).append(process_id)
            return children
        except (OSError, subprocess.SubprocessError, ValueError):
            return {}

    def descendant_pids(children):
        result = []
        pending = list(children.get(pid, []))
        while pending:
            process_id = pending.pop()
            result.append(process_id)
            pending.extend(children.get(process_id, []))
        return result

    def forward_signal(signum):
        children = process_children()
        # A provider supervisor may have sidecars below the Relay CLI. Snapshot
        # its complete descendant tree while leaving the CLI alive to finalize.
        targets = descendant_pids(children)
        if os.environ.get('RELAY_SIGNAL_PROCESS_GROUP') == '1':
            targets.insert(0, pid)
        for process_id in reversed(targets):
            try:
                os.kill(process_id, signum)
            except (OSError, ProcessLookupError):
                pass

    def handle_signal_forward(signum, _frame):
        forward_signal(signum)

    signal.signal(signal.SIGINT, handle_signal_forward)
    signal.signal(signal.SIGTERM, handle_signal_forward)

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    control = control_fd_open()
    events = event_fd_open()
    control_buffer = b''
    bridge_id = str(uuid.uuid4())
    parent_lost_at = None

    def send_frame(frame_type, **fields):
        if events is None:
            return
        payload = {'version': PROTOCOL_VERSION, 'type': frame_type, **fields}
        try:
            os.write(events, (json.dumps(payload) + '\n').encode('utf-8'))
        except OSError:
            pass

    send_frame(
        'ready',
        bridgeId=bridge_id,
        bridgePid=os.getpid(),
        childPid=pid,
    )

    inputs = [master, stdin]
    if control is not None:
        inputs.append(control)

    while True:
        readable, _, _ = select.select(inputs, [], [], 1.0)
        if control is not None:
            send_frame('heartbeat', bridgeId=bridge_id, childPid=pid)
        elif parent_lost_at is not None:
            elapsed = time.monotonic() - parent_lost_at
            if elapsed >= 4:
                forward_signal(signal.SIGKILL)
            elif elapsed >= 2:
                forward_signal(signal.SIGTERM)
            elif elapsed >= 0:
                forward_signal(signal.SIGINT)
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
                send_frame('parent_lost', bridgeId=bridge_id, childPid=pid)
                try:
                    os.kill(pid, signal.SIGHUP)
                except (OSError, ProcessLookupError):
                    pass
                control = None
                parent_lost_at = time.monotonic()
            else:
                control_buffer += chunk
                if len(control_buffer) > 65536:
                    control_buffer = b''
                    continue
                while b'\n' in control_buffer:
                    line, control_buffer = control_buffer.split(b'\n', 1)
                    if not line.strip():
                        continue
                    try:
                        message = json.loads(line)
                        if message.get('version') != PROTOCOL_VERSION:
                            send_frame('error', code='unsupported_protocol')
                            continue
                        action = message.get('action')

                        if action == 'resize':
                            set_winsize(
                                master,
                                parse_size(message.get('rows'), rows),
                                parse_size(message.get('cols'), cols),
                            )
                            send_frame('resize_ack', cols=message.get('cols'), rows=message.get('rows'))
                        elif action == 'interrupt':
                            try:
                                intent = message.get('intent')
                                os.kill(
                                    pid,
                                    signal.SIGUSR2
                                    if intent == 'user_stop'
                                    else signal.SIGHUP
                                    if intent == 'renderer_failure'
                                    else signal.SIGUSR1,
                                )
                            except (OSError, ProcessLookupError):
                                pass
                            forward_signal(
                                signal.SIGTERM
                                if intent == 'user_stop'
                                else signal.SIGINT
                            )
                        elif action == 'terminate':
                            forward_signal(signal.SIGTERM)
                        elif action == 'kill':
                            forward_signal(signal.SIGKILL)
                    except (AttributeError, ValueError, TypeError):
                        send_frame('error', code='invalid_frame')

    _, status = os.waitpid(pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)
    send_frame('provider_exit', exitCode=exit_code, childPid=pid)
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
