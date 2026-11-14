"""Supervised Browser child in One's owner container, under the same UID.

The private channel is transport, not a separate security boundary. Only trusted
startup selects Chromium's mode. EOF and deadlines settle the process group.
"""

from __future__ import annotations

import asyncio
import ctypes
import errno
import json
import os
import platform
import resource
import signal
import socket
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .launch_protocol import MAX_PACKET, LaunchRefused, connected_socket

ROOT = "/opt/browser"
ENTRYPOINT = ROOT + "/owner_entrypoint.py"
PYTHON = ROOT + "/venv/bin/python"
ENVIRONMENT = {
    "PATH": ROOT + "/venv/bin:/usr/local/bin:/usr/bin:/bin",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PLAYWRIGHT_BROWSERS_PATH": ROOT + "/browsers",
}

_SYS_LANDLOCK_CREATE_RULESET = 444
_SYS_LANDLOCK_ADD_RULE = 445
_SYS_LANDLOCK_RESTRICT_SELF = 446
_LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
_LANDLOCK_RULE_PATH_BENEATH = 1
_LANDLOCK_READ_EXEC_FS = (1 << 0) | (1 << 2) | (1 << 3)
_LANDLOCK_ABI_RIGHTS = {
    1: (1 << 13) - 1,
    2: (1 << 14) - 1,
    3: (1 << 15) - 1,
}
_LANDLOCK_READ_ONLY_PATHS = (
    ROOT,
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/proc",
    "/sys",
)
_LANDLOCK_READ_WRITE_PATHS = ("/dev",)


class _LandlockRulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class _LandlockPathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("allowed_access", ctypes.c_uint64),
        ("parent_fd", ctypes.c_int32),
    ]


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
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    native = ctypes.CDLL(None, use_errno=True)
    if native.prctl(38, 1, 0, 0, 0) or native.prctl(4, 0, 0, 0, 0):
        raise LaunchRefused()


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


def apply_landlock_worker_confinement(
    scratch_dir: str | None = None,
    *,
    native_lib: Any = None,
) -> str:
    """Confine the Browser worker's filesystem view on Landlock-capable Linux kernels.

    Restricts worker + Chromium descendants to ``/opt/browser``, OS runtime libraries,
    and the ephemeral ``MemoryScratch`` directory — excluding ``/app`` and ``/opt/venv``
    even on container runtimes (Azure Container Apps, AWS Fargate) where unprivileged
    user namespaces (``CLONE_NEWUSER``) are disabled. Cleanly returns ``"unsupported"``
    only when the kernel lacks Landlock (``ENOSYS`` / ``EOPNOTSUPP``, e.g. gVisor).
    """
    if sys.platform != "linux" or platform.machine().lower() not in {
        "x86_64",
        "amd64",
        "aarch64",
        "arm64",
    }:
        return "unsupported"
    native = native_lib if native_lib is not None else ctypes.CDLL(None, use_errno=True)
    ctypes.set_errno(0)
    abi = int(
        native.syscall(
            _SYS_LANDLOCK_CREATE_RULESET,
            ctypes.c_void_p(0),
            ctypes.c_size_t(0),
            ctypes.c_uint32(_LANDLOCK_CREATE_RULESET_VERSION),
        )
    )
    if abi < 0:
        err = ctypes.get_errno()
        if err in {errno.ENOSYS, errno.EOPNOTSUPP}:
            return "unsupported"
        raise LaunchRefused()
    effective_abi = min(max(abi, 1), 3)
    handled = _LANDLOCK_ABI_RIGHTS[effective_abi]
    ruleset_attr = _LandlockRulesetAttr(handled_access_fs=handled)
    ctypes.set_errno(0)
    ruleset_fd = int(
        native.syscall(
            _SYS_LANDLOCK_CREATE_RULESET,
            ctypes.byref(ruleset_attr),
            ctypes.c_size_t(ctypes.sizeof(ruleset_attr)),
            ctypes.c_uint32(0),
        )
    )
    if ruleset_fd < 0:
        err = ctypes.get_errno()
        if err in {errno.ENOSYS, errno.EOPNOTSUPP}:
            return "unsupported"
        raise LaunchRefused()
    o_path = getattr(os, "O_PATH", 0o10000000)
    open_flags = o_path | os.O_CLOEXEC
    rw_paths = list(_LANDLOCK_READ_WRITE_PATHS)
    resolved_scratch = scratch_dir or os.environ.get("TMPDIR") or os.environ.get("HOME") or ""
    if resolved_scratch and resolved_scratch not in rw_paths:
        rw_paths.append(resolved_scratch)
    try:
        for path, rights in (
            *(
                (candidate, _LANDLOCK_READ_EXEC_FS & handled)
                for candidate in _LANDLOCK_READ_ONLY_PATHS
            ),
            *((candidate, handled) for candidate in rw_paths),
        ):
            if not path or not os.path.exists(path):
                continue
            parent_fd = os.open(path, open_flags)
            try:
                rule_attr = _LandlockPathBeneathAttr(allowed_access=rights, parent_fd=parent_fd)
                if (
                    int(
                        native.syscall(
                            _SYS_LANDLOCK_ADD_RULE,
                            ctypes.c_int(ruleset_fd),
                            ctypes.c_int(_LANDLOCK_RULE_PATH_BENEATH),
                            ctypes.byref(rule_attr),
                            ctypes.c_uint32(0),
                        )
                    )
                    < 0
                ):
                    raise LaunchRefused()
            finally:
                os.close(parent_fd)
        if (
            int(
                native.syscall(
                    _SYS_LANDLOCK_RESTRICT_SELF, ctypes.c_int(ruleset_fd), ctypes.c_uint32(0)
                )
            )
            < 0
        ):
            raise LaunchRefused()
    finally:
        os.close(ruleset_fd)
    return f"enforced:abi{effective_abi}"


def run_worker(descriptor: int, mode: str) -> None:
    require_owner_process()
    apply_landlock_worker_confinement()
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
