"""Unprivileged launcher, created before the agent loads private information.

Only the bootstrap's inherited channel can request one fixed browser worker.
Channel loss, task timeout or malformed input tears down the namespace. This
process holds no application imports, credentials, storage or readiness authority.
"""

from __future__ import annotations

import ctypes
import os
import resource
import select
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from .launch_protocol import CONTROL_FD, WORKER_ID, LaunchRefused, connected_socket, receive, send
from .namespace_command import ENVIRONMENT, command
from .process_guard import _syscalls


def guard_launcher() -> None:
    if (
        sys.platform != "linux"
        or os.getresuid() != (WORKER_ID,) * 3
        or os.getresgid() != (WORKER_ID,) * 3
        or os.getgroups()
    ):
        raise LaunchRefused()
    native = ctypes.CDLL(None, use_errno=True)
    if native.prctl(38, 1, 0, 0, 0) or native.prctl(4, 0, 0, 0, 0):
        raise LaunchRefused()
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    if any(int(status[name], 16) for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")):
        raise LaunchRefused()
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))
    _syscalls(namespace_launcher=True)


def terminate(process: subprocess.Popen) -> None:
    # Kill before reaping, so a recycled PID cannot become the signal target.
    # The bwrap process is the only external owner of the private PID namespace;
    # die-with-parent and namespace-init death also kill detached descendants.
    for sig, wait in ((signal.SIGTERM, 2), (signal.SIGKILL, 3)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        # WNOWAIT retains identity until the final process-group fence.
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                break
            time.sleep(0.02)
        else:
            continue
        break
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=1)
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return
    raise LaunchRefused()


def serve(connection: socket.socket) -> None:
    connected_socket(connection, socket.SOCK_SEQPACKET)
    connection.settimeout(1)  # a stalled peer cannot block teardown/deadline checks
    process: subprocess.Popen | None = None
    active: str | None = None
    deadline = 0.0
    try:
        while True:
            if process is not None and (
                time.monotonic() >= deadline
                or os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            ):
                terminate(process)
                process, active = None, None
            if not select.select([connection], [], [], 1)[0]:
                continue
            operation, request_id, child = receive(connection)
            try:
                if operation == "launch" and process is None and child is not None:
                    process = subprocess.Popen(  # noqa: S603 - fixed image command, no caller argv
                        command(child.fileno()),
                        env=ENVIRONMENT,
                        cwd="/",
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        close_fds=True,
                        pass_fds=(child.fileno(),),
                        start_new_session=True,
                    )
                    active, deadline = request_id, time.monotonic() + 20 * 60
                    send(connection, "started", request_id)
                elif operation == "stop" and request_id == active and process is not None:
                    terminate(process)
                    process, active = None, None
                    send(connection, "stopped", request_id)
                elif operation == "stop" and process is None:
                    # Idempotent stop, including a task already expired locally.
                    send(connection, "stopped", request_id)
                else:
                    send(connection, "refused", request_id)
            finally:
                if child is not None:
                    child.close()
    finally:
        try:
            if process is not None:
                terminate(process)
        finally:
            connection.close()


def main() -> None:
    guard_launcher()
    with socket.socket(fileno=CONTROL_FD) as connection:
        serve(connection)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Worker diagnostics cannot include private task payloads or paths.
        raise SystemExit(1) from None
