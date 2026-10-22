"""Fixed worker bootstrap. Install restrictions before reading task metadata."""

from __future__ import annotations

import ctypes
import errno
import os
import socket
import stat
import sys
from pathlib import Path

from .launch_protocol import MAX_PACKET, WORKER_ID, LaunchRefused, connected_socket
from .namespace_command import SCRATCH, SHM
from .process_guard import _syscalls


def guard(bridge_fd: int, parent_network: str, parent_pid: str) -> None:
    if (
        sys.platform != "linux"
        or os.getresuid() != (WORKER_ID,) * 3
        or os.getresgid() != (WORKER_ID,) * 3
        or os.getgroups()
        or bridge_fd < 3
        or os.readlink("/proc/self/ns/net") == parent_network
        or os.readlink("/proc/self/ns/pid") == parent_pid
        or Path("/app").exists()
        or Path("/opt/venv").exists()
    ):
        raise LaunchRefused()
    native = ctypes.CDLL(None, use_errno=True)
    if native.prctl(38, 1, 0, 0, 0) or native.prctl(4, 0, 0, 0, 0):
        raise LaunchRefused()
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    if any(int(status[name], 16) for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")):
        raise LaunchRefused()
    for descriptor in (0, 1, 2):
        info = os.fstat(descriptor)
        if not stat.S_ISCHR(info.st_mode) or info.st_rdev != os.makedev(1, 3):
            raise LaunchRefused()
    # Close every unneeded descriptor before importing third-party runtime code.
    for entry in Path("/proc/self/fd").iterdir():
        descriptor = int(entry.name)
        if descriptor > 2 and descriptor != bridge_fd:
            try:
                os.close(descriptor)
            except OSError as exc:
                if exc.errno != errno.EBADF:
                    raise LaunchRefused() from None
    for path in (SCRATCH, SHM):
        filesystem = ctypes.create_string_buffer(256)
        if (
            native.statfs(os.fsencode(path), filesystem)
            or ctypes.c_long.from_buffer(filesystem).value != 0x01021994
        ):
            raise LaunchRefused()
        os.chmod(path, 0o700)
    os.umask(0o077)
    _syscalls()
    for family in (socket.AF_INET, socket.AF_INET6, 16):  # includes Linux AF_NETLINK
        try:
            with socket.socket(family, socket.SOCK_STREAM):
                raise LaunchRefused()
        except OSError as exc:
            if exc.errno != errno.EACCES:
                raise LaunchRefused() from None


def _read_exact(connection: socket.socket, size: int) -> bytes:
    result = b""
    while len(result) < size:
        chunk = connection.recv(size - len(result))
        if not chunk:
            raise LaunchRefused()
        result += chunk
    return result


def main(bridge_fd: int, parent_network: str, parent_pid: str) -> None:
    guard(bridge_fd, parent_network, parent_pid)
    with socket.socket(fileno=bridge_fd) as connection:
        connected_socket(connection, socket.SOCK_STREAM)
        connection.settimeout(15)
        size = int.from_bytes(_read_exact(connection, 4), "big")
        if not 0 < size <= MAX_PACKET:
            raise LaunchRefused()
        raw = _read_exact(connection, size)
        # Imports occur after namespace/descriptor/syscall enforcement.
        import asyncio

        from .connected_executor import ConnectedBrowserWorker
        from .contracts import BrowserBinding
        from .playwright_executor import PlaywrightExecutor

        binding = BrowserBinding.model_validate_json(raw)
        import time

        if binding.expires_at <= time.time():
            raise LaunchRefused()
        worker = ConnectedBrowserWorker(binding)
        executor = PlaywrightExecutor(network=worker, chromium_sandbox=True)
        # This acknowledgement proves local guards only, never cloud readiness.
        connection.sendall(b"\x00\x00\x00\x10" + b'{"guarded":true}')
        connection.settimeout(None)
        asyncio.run(worker.serve(connection, executor))


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise LaunchRefused()
        main(int(sys.argv[1]), sys.argv[2], sys.argv[3])
    except Exception:
        raise SystemExit(1) from None
