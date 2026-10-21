"""Fixed production namespace layout; no request controls mounts or executables."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = "/opt/browser"
PYTHON = ROOT + "/venv/bin/python"
SOURCE = ROOT + "/source"
SCRATCH = "/tmp"  # noqa: S108 - new bounded private tmpfs, not host /tmp  # nosec B108
SHM = "/dev/shm"  # noqa: S108 - new bounded private tmpfs, not host shared memory  # nosec B108
ENVIRONMENT = {
    "PATH": ROOT + "/venv/bin:/usr/local/bin:/usr/bin:/bin",
    "PYTHONPATH": SOURCE,
    "PYTHONSAFEPATH": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PLAYWRIGHT_BROWSERS_PATH": ROOT + "/browsers",
}


def command(bridge_fd: int) -> list[str]:
    if bridge_fd < 3:
        raise ValueError("BROWSER_BRIDGE_INVALID")
    arguments = [
        "/usr/bin/bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--uid",
        "10002",
        "--gid",
        "10002",
        "--cap-drop",
        "ALL",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
    ]
    environment = {**ENVIRONMENT, "HOME": SCRATCH, "TMPDIR": SCRATCH}
    for name, value in environment.items():
        arguments.extend(("--setenv", name, value))
    # /app, the application venv, host /tmp, /proc and cloud mounts are absent.
    # These are immutable image paths containing browser dependencies only.
    for path in ("/usr", "/lib", "/lib64", ROOT):
        if Path(path).exists():
            arguments.extend(("--ro-bind", path, path))
    for path in ("/etc/fonts", "/etc/ld.so.cache", "/etc/localtime"):
        if Path(path).exists():
            arguments.extend(("--ro-bind", path, path))
    arguments.extend(
        (
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--size",
            "67108864",
            "--tmpfs",
            SHM,
            "--size",
            "268435456",
            "--tmpfs",
            SCRATCH,
            "--chdir",
            SCRATCH,
            "--",
            PYTHON,
            "-m",
            "hushh_mcp.services.pod_browser.namespace_worker",
            str(bridge_fd),
            os.readlink("/proc/self/ns/net"),
            os.readlink("/proc/self/ns/pid"),
        )
    )
    return arguments
