"""Irreversible Linux restrictions for the pod's separate browser process.

Install before importing browser/application code, starting threads, or receiving
private payloads. This module does not issue a cloud-readiness receipt. The actual
installed image must also prove Chromium, broker transport and negative controls.
"""

from __future__ import annotations

import ctypes
import errno
import os
import platform
import socket
import stat
import sys
from pathlib import Path

WORKER_ID = 10002
_READ = (1 << 0) | (1 << 2) | (1 << 3)
_HANDLED_FS = (1 << 15) - 1  # ABI 3, including REFER and TRUNCATE
_WRITE_SCRATCH = _HANDLED_FS & ~((1 << 0) | (1 << 6) | (1 << 11))
_READ_ONLY = (
    "/usr",
    "/lib",
    "/lib64",
    "/opt/browser",
    "/opt/venv",
    "/ms-playwright",
    "/etc/fonts",
    "/etc/ssl/certs",
    "/etc/ld.so.cache",
    "/etc/localtime",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/proc/self",
    "/proc/thread-self",
    "/proc/cpuinfo",
    "/proc/meminfo",
    "/proc/stat",
    "/sys/devices/system/cpu",
)


class ProcessGuardRefused(RuntimeError):
    """Fixed non-private code; never propagate native errors or file contents."""


class _PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class _Comparison(ctypes.Structure):
    _fields_ = [
        ("argument", ctypes.c_uint),
        ("operation", ctypes.c_int),
        ("value", ctypes.c_uint64),
        ("mask", ctypes.c_uint64),
    ]


def _filesystem(native: ctypes.CDLL, scratch: Path) -> int:
    # These syscall numbers are shared by the explicitly supported Linux ABIs.
    abi = int(native.syscall(444, None, 0, 1))
    if abi < 3:
        raise ProcessGuardRefused("BROWSER_FILESYSTEM_GUARD_UNAVAILABLE")
    access = ctypes.c_uint64(_HANDLED_FS)
    ruleset = native.syscall(444, ctypes.byref(access), ctypes.sizeof(access), 0)
    if ruleset < 0:
        raise ProcessGuardRefused("BROWSER_FILESYSTEM_GUARD_UNAVAILABLE")
    try:
        paths = [(path, _READ) for path in _READ_ONLY if Path(path).exists()]
        paths.append((str(scratch), _WRITE_SCRATCH))
        paths.extend(
            (path, (1 << 1) | (1 << 2))
            for path in (
                "/dev/null",
                "/dev/zero",
                "/dev/random",
                "/dev/urandom",
            )
        )
        for path, allowed in paths:
            path_flag = getattr(os, "O_PATH", None)
            if path_flag is None:
                raise ProcessGuardRefused("BROWSER_FILESYSTEM_GUARD_UNAVAILABLE")
            fd = os.open(path, path_flag | os.O_CLOEXEC)
            try:
                if not Path(path).is_dir():
                    allowed &= (1 << 0) | (1 << 1) | (1 << 2) | (1 << 14)
                rule = _PathRule(allowed, fd)
                if native.syscall(445, ruleset, 1, ctypes.byref(rule), 0) != 0:
                    raise ProcessGuardRefused("BROWSER_FILESYSTEM_GUARD_REFUSED")
            finally:
                os.close(fd)
        if native.syscall(446, ruleset, 0) != 0:
            raise ProcessGuardRefused("BROWSER_FILESYSTEM_GUARD_REFUSED")
    finally:
        os.close(ruleset)
    return abi


def _local_socket_types(
    library: ctypes.CDLL, context: int, deny: int, number: int, *, paired: bool
) -> None:
    # Denying connect alone does not constrain Unix datagrams: sendto/sendmsg
    # can name an external abstract/path recipient. Preserve CLOEXEC/NONBLOCK
    # flags. Chromium's sandbox needs connected SEQPACKET socketpairs for its
    # zygote IPC. Only socketpair may create them: no external recipient is
    # selectable, and connect/bind/listen remain denied independently.
    permitted = {socket.SOCK_STREAM, socket.SOCK_SEQPACKET} if paired else {socket.SOCK_STREAM}
    for kind in (value for value in range(16) if value not in permitted):
        comparison = _Comparison(1, 7, 0xF, kind)  # SCMP_CMP_MASKED_EQ
        if library.seccomp_rule_add_array(context, deny, number, 1, ctypes.byref(comparison)) != 0:
            raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")


def _launcher_socket_families(library: ctypes.CDLL, context: int, deny: int, number: int) -> None:
    # bubblewrap configures only its new loopback through NETLINK_ROUTE. Its
    # if_nametoindex ioctl also needs a local Unix datagram socket. Neither may
    # create an internet socket; the worker tightens both after namespace setup.
    for family in range(65):
        if family in (socket.AF_UNIX, 16):  # AF_NETLINK on Linux
            continue
        comparison = _Comparison(0, 4, family, 0)  # SCMP_CMP_EQ
        if library.seccomp_rule_add_array(context, deny, number, 1, ctypes.byref(comparison)):
            raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")
    comparison = _Comparison(0, 5, 65, 0)  # SCMP_CMP_GE, including unknown families
    if library.seccomp_rule_add_array(context, deny, number, 1, ctypes.byref(comparison)):
        raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")
    comparisons = (_Comparison * 2)(_Comparison(0, 4, 16, 0), _Comparison(2, 1, 0, 0))
    if library.seccomp_rule_add_array(context, deny, number, 2, comparisons):
        raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")


def _syscalls(*, namespace_launcher: bool = False) -> None:
    try:
        library = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    except OSError:
        raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_UNAVAILABLE") from None
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
        ctypes.POINTER(_Comparison),
    ]
    library.seccomp_attr_set.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32]
    context = library.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not context:
        raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_UNAVAILABLE")
    try:
        # Reject foreign ABIs and x32, rather than accidentally permitting a
        # different syscall table. libseccomp generates native-architecture checks.
        if library.seccomp_attr_set(context, 2, 0x80000000) != 0:  # ACT_BADARCH / KILL
            raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")
        names = (
            "connect",
            "listen",
            "accept",
            "accept4",
            "socketcall",
            "io_uring_setup",
            "io_uring_enter",
            "io_uring_register",
            "ptrace",
            "process_vm_readv",
            "process_vm_writev",
            "pidfd_getfd",
            "bpf",
            "open_by_handle_at",
        )
        # The clean fixed-command launcher creates the namespaces. It never
        # handles page input; only its worker can use the stricter inherited
        # filter below. Network and process-inspection denials apply to both.
        if not namespace_launcher:
            names += ("mount", "bind")
        deny = 0x00050000 | errno.EACCES  # SCMP_ACT_ERRNO
        for name in (*names, "socket", "socketpair"):
            number = library.seccomp_syscall_resolve_name(name.encode())
            if number < 0:
                if name == "socketcall":  # multiplexor is absent on native amd64/arm64
                    continue
                raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")
            if name == "socket" and namespace_launcher:
                _launcher_socket_families(library, context, deny, number)
                continue
            comparison = _Comparison(0, 1, socket.AF_UNIX, 0)  # SCMP_CMP_NE
            conditional = name in {"socket", "socketpair"}
            if (
                library.seccomp_rule_add_array(
                    context,
                    deny,
                    number,
                    int(conditional),
                    ctypes.byref(comparison) if conditional else None,
                )
                != 0
            ):
                raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")
            if conditional:
                _local_socket_types(library, context, deny, number, paired=name == "socketpair")
        if library.seccomp_load(context) != 0:
            raise ProcessGuardRefused("BROWSER_SYSCALL_GUARD_REFUSED")
    finally:
        library.seccomp_release(context)


def restrict_browser_process(*, scratch: Path, bridge_fd: int) -> dict[str, int]:
    """Use only in a fresh fixed-UID child with one inherited connected bridge.

    The trusted launcher owns scratch allocation/removal and process termination.
    No caller-selected executable, environment, path allowlist or network FD is
    accepted. Every error aborts startup; restrictions are never best effort.
    """
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "aarch64"}:
        raise ProcessGuardRefused("BROWSER_PROCESS_GUARD_UNAVAILABLE")
    if (
        os.getresuid() != (WORKER_ID,) * 3
        or os.getresgid() != (WORKER_ID,) * 3
        or os.getgroups()
        or len(list(Path("/proc/self/task").iterdir())) != 1
    ):
        raise ProcessGuardRefused("BROWSER_WORKER_IDENTITY_REFUSED")
    scratch = scratch.resolve(strict=True)
    info = scratch.stat()
    if (
        scratch.parent != Path("/dev/shm")  # noqa: S108 - verified tmpfs, not a temporary name  # nosec B108
        or info.st_uid != WORKER_ID
        or info.st_mode & 0o077
    ):
        raise ProcessGuardRefused("BROWSER_MEMORY_SCRATCH_REQUIRED")
    native = ctypes.CDLL(None, use_errno=True)
    filesystem = ctypes.create_string_buffer(256)
    if (
        native.statfs(os.fsencode(scratch), filesystem) != 0
        or ctypes.c_long.from_buffer(filesystem).value != 0x01021994
    ):
        raise ProcessGuardRefused("BROWSER_MEMORY_SCRATCH_REQUIRED")
    if bridge_fd < 3:
        raise ProcessGuardRefused("BROWSER_BRIDGE_INVALID")
    with socket.socket(fileno=os.dup(bridge_fd)) as bridge:
        if (
            bridge.family != socket.AF_UNIX
            or bridge.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
        ):
            raise ProcessGuardRefused("BROWSER_BRIDGE_INVALID")
        bridge.getpeername()  # unconnected descriptors are refused
    for descriptor in (0, 1, 2):
        stdio = os.fstat(descriptor)
        if not stat.S_ISCHR(stdio.st_mode) or stdio.st_rdev != os.makedev(1, 3):
            raise ProcessGuardRefused("BROWSER_DESCRIPTOR_GUARD_REFUSED")
    for entry in Path("/proc/self/fd").iterdir():
        descriptor = int(entry.name)
        if descriptor > 2 and descriptor != bridge_fd:
            try:
                os.close(descriptor)
            except OSError as exc:
                if exc.errno != errno.EBADF:
                    raise ProcessGuardRefused("BROWSER_DESCRIPTOR_GUARD_REFUSED") from None
    os.environ.clear()
    os.environ.update(
        {
            "HOME": str(scratch),
            "TMPDIR": str(scratch),
            "XDG_CACHE_HOME": str(scratch / "cache"),
            "XDG_CONFIG_HOME": str(scratch / "config"),
            "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
            "PLAYWRIGHT_BROWSERS_PATH": "/opt/browser/browsers",
        }
    )
    os.chdir(scratch)
    if native.prctl(38, 1, 0, 0, 0) != 0 or native.prctl(4, 0, 0, 0, 0) != 0:
        raise ProcessGuardRefused("BROWSER_PROCESS_GUARD_REFUSED")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    if any(int(status[key].strip(), 16) for key in ("CapPrm", "CapEff", "CapAmb")):
        raise ProcessGuardRefused("BROWSER_WORKER_IDENTITY_REFUSED")
    abi = _filesystem(native, scratch)
    _syscalls()
    return {"landlock_abi": abi, "worker_uid": WORKER_ID}
