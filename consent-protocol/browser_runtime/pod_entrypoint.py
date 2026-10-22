"""Fixed non-root One bootstrap; Browser children share its owner container."""

from __future__ import annotations

import ctypes
import errno
import os
import stat
import sys


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


def main() -> None:
    if sys.argv[1:] or sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("POD_BOOTSTRAP_REFUSED")
    os.umask(0o077)
    host_secret()
    drop(10001)
    port = int(os.environ.get("PORT", "8080"))
    if not 1 <= port <= 65535:
        raise RuntimeError("POD_PORT_INVALID")
    os.chdir("/app")
    os.execve(  # noqa: S606 - fixed single-worker pod entrypoint
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


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("POD_BOOTSTRAP_REFUSED") from None
