"""Synthetic in-pod namespace qualification; never issues Browser readiness.

Use a disposable image with pinned Chromium; record its bubblewrap version and
immutable image digest. No owner information,
model call, credential or public network request enters this probe.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
from pathlib import Path

PREFIX = "HUSSH_BROWSER_NAMESPACE_PROBE:"
_SCRATCH = "/tmp"  # noqa: S108 - fresh private tmpfs inside the mount namespace  # nosec B108
_SHM = "/dev/shm"  # noqa: S108 - fresh private tmpfs, never the host mount  # nosec B108


def verify_isolation() -> dict:
    from .process_guard import _syscalls

    native = ctypes.CDLL(None, use_errno=True)
    if native.prctl(38, 1, 0, 0, 0) or native.prctl(4, 0, 0, 0, 0):
        return {"code": "BROWSER_PROCESS_GUARD_REFUSED"}
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    result: dict[str, object] = {
        "uid": os.geteuid(),
        "zero_capabilities": all(
            int(status[key].strip(), 16) == 0 for key in ("CapPrm", "CapEff", "CapAmb")
        ),
        "no_new_privileges": status["NoNewPrivs"].strip() == "1",
        "agent_path_absent": not Path("/agent").exists(),
        "agent_environment_absent": "HUSSH_POD_CANARY" not in os.environ,
        "private_proc": b"HUSSH_POD_CANARY" not in Path("/proc/1/environ").read_bytes(),
        "network_namespace_isolated": os.readlink("/proc/self/ns/net") != sys.argv[2],
        "frame_verified": False,
    }
    if not all(value for key, value in result.items() if key not in {"uid", "frame_verified"}):
        return {**result, "code": "BROWSER_NAMESPACE_GUARD_REFUSED"}
    if result["uid"] != 10002:
        return {**result, "code": "BROWSER_WORKER_IDENTITY_REFUSED"}
    _syscalls()
    left, right = socket.socketpair(type=socket.SOCK_SEQPACKET)
    with left, right:
        left.sendall(b"synthetic-browser-ipc")
        result["chromium_ipc_available"] = right.recv(64) == b"synthetic-browser-ipc"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM):
            result["external_datagram_denied"] = False
    except OSError as exc:
        result["external_datagram_denied"] = exc.errno == 13
    if not result["chromium_ipc_available"] or not result["external_datagram_denied"]:
        return {**result, "code": "BROWSER_IPC_GUARD_REFUSED"}
    # Network namespace isolation is independent of browser routing. No real
    # listener or credential endpoint is contacted: there must be no host route.
    denied = {}
    socket_errnos = {}
    socket_denied = {}
    for label, address in (
        ("public", "192.0.2.1"),
        ("metadata", "169.254.169.254"),
        ("private", "10.0.0.1"),
    ):
        created = False
        try:
            with socket.socket() as connection:
                created = True
                connection.settimeout(1)
                connection.connect((address, 80))
                denied[label] = False
        except OSError as exc:
            denied[label] = exc.errno in {1, 13, 101, 113}
            socket_errnos[label] = exc.errno
            socket_denied[label] = not created and exc.errno == 13
    result["network_denials"] = denied
    result["network_denial_errnos"] = socket_errnos
    result["network_socket_creation_denied"] = socket_denied
    if not all(denied.values()) or not all(socket_denied.values()):
        return {**result, "code": "BROWSER_NETWORK_ISOLATION_REFUSED"}
    return {**result, "code": "BROWSER_NAMESPACE_GUARDS_VERIFIED"}


def _inside() -> dict:
    result = verify_isolation()
    if result.get("code") != "BROWSER_NAMESPACE_GUARDS_VERIFIED":
        return result
    return {**result, **_frame()}


def _frame() -> dict:
    # Match Playwright's default headless executor. Full Chrome's process
    # singleton needs a listening socket, which this boundary intentionally
    # forbids. Headless shell retains Chromium's sandbox without that desktop
    # profile coordination.
    candidates = list(
        Path("/ms-playwright").glob("chromium_headless_shell-*/chrome-*/headless_shell")
    )
    candidates.extend(
        Path("/ms-playwright").glob("chromium_headless_shell-*/chrome-*/chrome-headless-shell")
    )
    if len(candidates) != 1:
        return {"code": "BROWSER_BINARY_UNAVAILABLE"}
    output = Path(_SCRATCH) / "frame.png"
    with (Path(_SCRATCH) / "chromium-errors").open("wb+") as errors:
        process = subprocess.Popen(  # noqa: S603 - pinned binary and synthetic page only
            [
                str(candidates[0]),
                "--headless",
                "--no-first-run",
                "--disable-background-networking",
                "--disable-dev-shm-usage",
                "--window-size=1280,720",
                "--user-data-dir=/tmp/profile",
                "--screenshot=/tmp/frame.png",
                "data:text/html,<title>Browser qualification</title><h1>Private browser</h1>",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=errors,
            start_new_session=True,
            close_fds=True,
        )
        try:
            process.wait(timeout=35)
        except subprocess.TimeoutExpired:
            pass
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
        errors.seek(0)
        diagnostic = errors.read(8192).lower()
    frame = output.read_bytes() if output.is_file() and output.stat().st_size <= 4194304 else b""
    verified = process.returncode == 0 and frame.startswith(b"\x89PNG\r\n\x1a\n")
    return {
        "frame_verified": verified,
        "frame_bytes": len(frame),
        "frame_sha256": hashlib.sha256(frame).hexdigest(),
        "chromium_exit": process.returncode,
        "sandbox_refused": b"no usable sandbox" in diagnostic,
        "namespace_refused": b"operation not permitted" in diagnostic,
        "code": "BROWSER_NAMESPACE_FRAME_VERIFIED" if verified else "BROWSER_FRAME_REFUSED",
        # Synthetic-only image, fixed page, empty environment and no owner
        # mounts. Keep only a bounded diagnostic for this qualification path.
        "synthetic_diagnostic": diagnostic.decode("utf-8", errors="replace")[:2048]
        if not verified
        else "",
    }


def _command(*, bridge_fd: int | None = None, public_probe: bool = False) -> list[str]:
    # bubblewrap creates a new mount root, PID, IPC and network namespaces.
    # Only immutable browser/Python libraries are visible, with private tmpfs.
    command = [
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
        "--setenv",
        "PATH",
        "/usr/local/bin:/usr/bin:/bin",
        "--setenv",
        "HOME",
        _SCRATCH,
        "--setenv",
        "TMPDIR",
        _SCRATCH,
        "--setenv",
        "PYTHONPATH",
        "/opt/probe",
        "--setenv",
        "PLAYWRIGHT_BROWSERS_PATH",
        "/ms-playwright",
    ]
    for path in ("/usr", "/lib", "/lib64", "/ms-playwright", "/opt/probe"):
        if Path(path).exists():
            command.extend(("--ro-bind", path, path))
    for path in ("/etc/fonts", "/etc/ld.so.cache", "/etc/localtime", "/etc/passwd", "/etc/group"):
        if Path(path).exists():
            command.extend(("--ro-bind", path, path))
    command.extend(
        (
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            _SHM,
            "--tmpfs",
            _SCRATCH,
            "--chdir",
            _SCRATCH,
            "--",
            sys.executable,
            "-m",
            "hushh_mcp.services.pod_browser."
            + (
                "namespace_public_probe"
                if public_probe
                else "namespace_probe"
                if bridge_fd is None
                else "namespace_bridge_probe"
            ),
            "--inside",
            os.readlink("/proc/self/ns/net"),
        )
    )
    if bridge_fd is not None:
        command.append(str(bridge_fd))
    return command


def run_probe() -> dict:
    if sys.platform != "linux" or os.geteuid() != 10002:
        return {"code": "BROWSER_WORKER_IDENTITY_REFUSED"}
    if not Path("/agent/synthetic-secret").is_file() or "HUSSH_POD_CANARY" not in os.environ:
        return {"code": "BROWSER_NEGATIVE_CONTROL_MISSING"}
    with subprocess.Popen(  # noqa: S603 - fixed probe executable and allowlisted paths
        _command(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
        start_new_session=True,
    ) as process:
        try:
            output, errors = process.communicate(timeout=55)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=5)
            return {"code": "BROWSER_NAMESPACE_PROBE_TIMEOUT"}
    if process.returncode != 0 or len(output) > 16384:
        return {
            "code": "BROWSER_NAMESPACE_LAUNCH_REFUSED",
            "exit_code": process.returncode,
            "namespace_refused": b"operation not permitted" in errors.lower(),
        }
    result = json.loads(output)
    result["launcher_exited"] = True
    return result


if __name__ == "__main__":
    try:
        inside = len(sys.argv) == 3 and sys.argv[1] == "--inside"
        value = _inside() if inside else run_probe()
        print(("" if inside else PREFIX) + json.dumps(value), flush=True)
    except Exception:
        print(json.dumps({"code": "BROWSER_NAMESPACE_PROBE_REFUSED"}), flush=True)
        raise SystemExit(1) from None
