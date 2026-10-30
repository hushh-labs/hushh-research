"""Supervised Browser child in One's owner container, under the same UID.

The private channel is transport, not a separate security boundary. Only trusted
startup selects Chromium's mode. EOF and deadlines settle the process group.
"""

from __future__ import annotations

import asyncio
import ctypes
import json
import os
import signal
import socket
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from .launch_protocol import MAX_PACKET, LaunchRefused, connected_socket

ROOT = "/opt/browser"
ENTRYPOINT = ROOT + "/owner_entrypoint.py"
PYTHON = ROOT + "/venv/bin/python"
ENVIRONMENT = {
    "PATH": ROOT + "/venv/bin:/usr/local/bin:/usr/bin:/bin",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PLAYWRIGHT_BROWSERS_PATH": ROOT + "/browsers",
}


def execution_ack(chromium_sandbox: bool) -> bytes:
    raw = json.dumps(
        {"version": 2, "boundary": "shared_owner_container", "chromium_sandbox": chromium_sandbox},
        separators=(",", ":"),
    ).encode()
    return len(raw).to_bytes(4, "big") + raw


def require_owner_process() -> None:
    if sys.platform != "linux" or os.geteuid() == 0 or os.getuid() != os.geteuid():
        raise LaunchRefused()
    os.umask(0o077)


def reap_owned_children() -> None:
    """This dedicated supervisor owns only the Browser subtree.

    Linux reparents orphaned descendants to this subreaper. Reap them before
    acknowledging stop, including descendants that changed process group.
    Unreaped children retain their PID until this process performs waitpid.
    """
    deadline = time.monotonic() + 3
    children = Path(f"/proc/self/task/{os.getpid()}/children")
    while True:
        pids = [int(value) for value in children.read_text().split()]
        if not pids:
            return
        if time.monotonic() >= deadline:
            raise LaunchRefused()
        for pid in pids:
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
                if not waited:
                    os.kill(pid, signal.SIGKILL)
            except (ChildProcessError, ProcessLookupError):
                pass
        time.sleep(0.02)


def _read_exact(connection: socket.socket, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        part = connection.recv(size - len(result))
        if not part:
            raise LaunchRefused()
        result.extend(part)
    return bytes(result)


def supervise(descriptor: int, mode: str) -> None:
    from .launch_service import serve

    require_owner_process()
    # Lifecycle ownership only: this does not isolate Browser from One.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):  # PR_SET_CHILD_SUBREAPER
        raise LaunchRefused()

    def interrupted(_signal, _frame):
        raise LaunchRefused()

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    @contextmanager
    def worker(channel: int):
        # The supervisor owns scratch so even SIGKILL of the Browser child
        # cannot leave its task directory behind after a confirmed stop.
        from .scratch import MemoryScratch

        # The provider's tmpfs capacity is shared, not a task-directory quota.
        # Custody requires actual tmpfs; the pod allocation, bounded transport,
        # action budget and measured headroom own runtime capacity.
        scratch = MemoryScratch()
        try:
            arguments = [PYTHON, "-I", ENTRYPOINT, "--worker", str(channel), mode]
            directory = str(scratch.path)
            yield arguments, {**ENVIRONMENT, "HOME": directory, "TMPDIR": directory}, directory
        finally:
            scratch.close()

    with socket.socket(fileno=descriptor) as connection:
        serve(connection, worker=worker, settle=reap_owned_children)


def run_worker(descriptor: int, mode: str) -> None:
    require_owner_process()
    from .connected_executor import ConnectedBrowserWorker
    from .contracts import BrowserBinding
    from .playwright_executor import PlaywrightExecutor

    with socket.socket(fileno=descriptor) as connection:
        connected_socket(connection, socket.SOCK_STREAM)
        connection.settimeout(15)
        size = int.from_bytes(_read_exact(connection, 4), "big")
        if not 0 < size <= MAX_PACKET:
            raise LaunchRefused()
        binding = BrowserBinding.model_validate_json(_read_exact(connection, size))
        if binding.expires_at <= time.time():
            raise LaunchRefused()
        worker = ConnectedBrowserWorker(binding)
        sandbox = mode == "enabled"
        executor = PlaywrightExecutor(network=worker, chromium_sandbox=sandbox)
        connection.sendall(execution_ack(sandbox))
        connection.settimeout(None)
        asyncio.run(worker.serve(connection, executor))


def main() -> None:
    if (
        len(sys.argv) != 4
        or sys.argv[1] not in {"--supervise", "--worker"}
        or sys.argv[3] not in {"enabled", "disabled"}
    ):
        raise LaunchRefused()
    descriptor = int(sys.argv[2])
    if descriptor < 3:
        raise LaunchRefused()
    if sys.argv[1] == "--supervise":
        supervise(descriptor, sys.argv[3])
    else:
        run_worker(descriptor, sys.argv[3])
