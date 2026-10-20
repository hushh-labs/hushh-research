"""Fixed container entrypoint. Run with Python -I -S, before application imports.

Root exists only for the two irreversible identity drops. The browser helper is
execed with a new descriptor table and allowlisted environment before One loads
keys. Disabled Browser starts no helper. No argument supplies an executable.
"""

from __future__ import annotations

import ctypes
import errno
import os
import signal
import socket
import stat
import sys

_SOURCE = "/opt/browser/source"
_SELF = "/opt/browser/pod_entrypoint.py"
_PYTHON = "/opt/browser/venv/bin/python"
_FD = 3


def host_secret() -> None:
    """VM bootstrap only; never persist the signing value in Docker's config.

    Read AFTER the clean helper has execed/forked, before the agent identity drop.
    Existing Cloud Run/Container Apps secret injection is unchanged.
    """
    if not os.path.exists("/run/hussh-host/pod.json"):
        return
    if os.environ.get("APP_SIGNING_KEY"):
        raise RuntimeError("VM_SIGNING_SECRET_SOURCE_CONFLICT")
    descriptor = os.open("/run/hussh-secrets/app-signing-key", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if info.st_uid != 0 or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
            raise RuntimeError("VM_SIGNING_SECRET_UNPROTECTED")
        value = source.read(16385)
    if not 32 <= len(value) <= 16384 or b"\x00" in value:
        raise RuntimeError("VM_SIGNING_SECRET_INVALID")
    os.environ["APP_SIGNING_KEY"] = value.decode("utf-8")


def inherit_channel(descriptor: int) -> None:
    os.dup2(descriptor, _FD, inheritable=True)
    # dup2(fd, fd) is a no-op, including its close-on-exec flag. Socketpairs
    # commonly allocate FD 3 first, so explicitly retain it for the fixed exec.
    os.set_inheritable(_FD, True)
    if descriptor != _FD:
        os.close(descriptor)


def drop(uid: int) -> None:
    if sys.platform != "linux":
        raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")
    native = ctypes.CDLL(None, use_errno=True)
    # Drop the capability bounding set while CAP_SETPCAP is still available.
    for capability in range(64):
        present = native.prctl(23, capability, 0, 0, 0)  # PR_CAPBSET_READ
        if present < 0 and ctypes.get_errno() != errno.EINVAL:
            raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")
        if present > 0 and native.prctl(24, capability, 0, 0, 0):  # DROP
            raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")
    os.setgroups([])
    os.setresgid(uid, uid, uid)
    os.setresuid(uid, uid, uid)
    # setuid clears permitted/effective sets, but not inherited capabilities.
    # Explicitly empty every capability set before the clean exec.
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
    capabilities = (ctypes.c_uint32 * 6)()
    if native.capset(ctypes.byref(header), ctypes.byref(capabilities)):
        raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")
    if (
        os.getresuid() != (uid,) * 3
        or os.getresgid() != (uid,) * 3
        or os.getgroups()
        or native.prctl(38, 1, 0, 0, 0)
        or native.prctl(4, 0, 0, 0, 0)
    ):
        raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")
    with open("/proc/self/status") as handle:
        status = dict(line.split(":", 1) for line in handle if ":" in line)
    if any(int(status[name], 16) for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")):
        raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")


def helper(child: socket.socket, parent_pid: int) -> None:
    # Nothing inherited except one channel; stdio cannot expose a private error.
    descriptor = child.detach()
    inherit_channel(descriptor)
    for name in os.listdir("/proc/self/fd"):
        value = int(name)
        if value > 2 and value != _FD:
            try:
                os.close(value)
            except OSError:
                pass
    with open("/dev/null", "rb+") as devnull:
        for value in (0, 1, 2):
            os.dup2(devnull.fileno(), value)
    drop(10002)
    # A dead bootstrap/gunicorn master must not leave an independent launcher.
    native = ctypes.CDLL(None, use_errno=True)
    if native.prctl(1, signal.SIGTERM, 0, 0, 0) or os.getppid() != parent_pid:
        raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")
    os.chdir("/")
    os.execve(  # noqa: S606 - fixed clean helper, no caller executable or arguments
        _PYTHON,
        [_PYTHON, "-I", "-S", _SELF, "--helper"],
        {"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
    )


def main() -> None:
    if sys.argv[1:] == ["--helper"]:
        # Fresh unprivileged exec; fixed source, no site/custom PYTHONPATH hooks.
        sys.path.insert(0, _SOURCE)
        from hushh_mcp.services.pod_browser.launch_service import main as run_helper

        run_helper()
        return
    if sys.argv[1:] or sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("BROWSER_BOOTSTRAP_REFUSED")
    os.umask(0o077)
    os.environ.pop("HUSSH_BROWSER_LAUNCH_FD", None)
    child_pid = None
    try:
        if os.environ.get("POD_COMPUTER_USE_ENABLED", "").lower() in {"1", "true"}:
            parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            parent_pid = os.getpid()
            child_pid = os.fork()
            if child_pid == 0:
                parent.close()
                helper(child, parent_pid)
                os._exit(1)
            child.close()
            descriptor = parent.detach()
            inherit_channel(descriptor)
            os.environ["HUSSH_BROWSER_LAUNCH_FD"] = str(_FD)
        host_secret()
        drop(10001)
        port = int(os.environ.get("PORT", "8080"))
        if not 1 <= port <= 65535:
            raise RuntimeError("POD_PORT_INVALID")
        os.chdir("/app")
        os.execve(  # noqa: S606 - existing fixed single-worker pod entrypoint
            "/opt/venv/bin/gunicorn",
            [
                "/opt/venv/bin/gunicorn",
                "pod_server:app",
                "-w",
                "1",
                "-k",
                "uvicorn.workers.UvicornWorker",
                "-c",
                "/opt/browser/gunicorn_lifecycle.py",
                "--timeout",
                "120",
                "-b",
                f"0.0.0.0:{port}",
            ],
            dict(os.environ),
        )
    except BaseException:
        if child_pid and os.geteuid() == 0:
            os.kill(child_pid, signal.SIGTERM)
            os.waitpid(child_pid, 0)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("POD_BOOTSTRAP_REFUSED") from None
