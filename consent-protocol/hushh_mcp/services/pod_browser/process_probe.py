"""Synthetic qualification of the built-in browser process, never owner access.

Run in a disposable ordinary cloud container, as root only for fixed UID setup.
No provider/model request, task goal, owner key or login is accepted by this probe.
"""

from __future__ import annotations

import argparse
import errno
import glob
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

from .process_guard import ProcessGuardRefused, restrict_browser_process

_MAX_RESULT = 16384


def _frame(scratch: Path) -> dict:
    candidates = glob.glob("/ms-playwright/chromium-*/chrome-linux*/chrome") + glob.glob(
        "/opt/browser/browsers/chromium-*/chrome-linux*/chrome"
    )
    if len(candidates) != 1:
        return {"frame_verified": False, "code": "BROWSER_BINARY_UNAVAILABLE"}
    output = scratch / "frame.png"
    with tempfile.TemporaryFile(dir=scratch) as errors:
        process = subprocess.Popen(  # noqa: S603 - immutable-image Chromium, fixed synthetic page
            [
                candidates[0],
                "--headless",
                "--no-first-run",
                "--disable-background-networking",
                "--disable-dev-shm-usage",
                "--window-size=1280,720",
                "--user-data-dir=" + str(scratch / "profile"),
                "--screenshot=" + str(output),
                "about:blank",
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
            process.kill()
            process.wait(timeout=5)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        errors.seek(0)
        diagnostic = errors.read(8192).lower()
    frame = output.read_bytes() if output.is_file() and output.stat().st_size <= 4194304 else b""
    return {
        "frame_verified": process.returncode == 0 and frame.startswith(b"\x89PNG\r\n\x1a\n"),
        "frame_bytes": len(frame),
        "frame_sha256": hashlib.sha256(frame).hexdigest(),
        "exit_code": process.returncode,
        "sandbox_refused": b"no usable sandbox" in diagnostic,
        "namespace_refused": b"operation not permitted" in diagnostic,
    }


def _inside(bridge_fd: int, scratch: Path, canary: Path, *, chromium: bool = True) -> dict:
    result: dict = {"guard_verified": False, "frame_verified": False}
    try:
        facts = restrict_browser_process(scratch=scratch, bridge_fd=bridge_fd)
        result.update(facts)
        result["guard_verified"] = True
        # This file is deliberately world-readable. DAC alone cannot pass this
        # negative control; the installed filesystem guard must deny its read.
        try:
            canary.read_bytes()
            result["unrelated_file_denied"] = False
        except OSError as exc:
            result["unrelated_file_denied"] = exc.errno in {errno.EACCES, errno.EPERM}
        denials = {}
        for name in ("AF_INET", "AF_INET6", "AF_NETLINK", "AF_PACKET", "AF_VSOCK"):
            try:
                with socket.socket(getattr(socket, name), socket.SOCK_STREAM):
                    denials[name] = False
            except OSError as exc:
                denials[name] = exc.errno == errno.EACCES
        result["socket_families_denied"] = denials
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as datagram:
                datagram.sendto(b"synthetic-probe", "\0" + scratch.name)
            result["external_unix_datagram_denied"] = False
        except OSError as exc:
            result["external_unix_datagram_denied"] = exc.errno == errno.EACCES
        status = Path("/proc/self/status").read_text()
        result["seccomp_filter_observed"] = any(
            line.split() == ["Seccomp:", "2"] for line in status.splitlines()
        )
        if (
            chromium
            and result["unrelated_file_denied"]
            and result["external_unix_datagram_denied"]
            and all(denials.values())
        ):
            result.update(_frame(scratch))
        result["code"] = (
            "BROWSER_PROCESS_PROBE_COMPLETE" if chromium else "BROWSER_PROCESS_GUARDS_COMPLETE"
        )
    except ProcessGuardRefused as exc:
        result["code"] = str(exc)
    except Exception:
        result["code"] = "BROWSER_PROCESS_PROBE_REFUSED"
    return result


def _receive_result(channel: socket.socket) -> dict:
    data = bytearray()
    while len(data) <= _MAX_RESULT:
        chunk = channel.recv(min(4096, _MAX_RESULT + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    if len(data) > _MAX_RESULT:
        raise ValueError()
    result = json.loads(data)
    if not isinstance(result, dict):
        raise ValueError()
    return result


def run_probe(*, chromium: bool = True) -> dict:
    if os.geteuid() != 0:
        return {"code": "BROWSER_TRUSTED_STARTUP_UNAVAILABLE", "guard_verified": False}
    result: dict = {"code": "BROWSER_PROCESS_PROBE_REFUSED", "guard_verified": False}
    with tempfile.TemporaryDirectory(prefix="browser-probe-", dir="/dev/shm") as directory:  # noqa: S108  # nosec B108
        root = Path(directory)
        os.chmod(root, 0o711)  # noqa: S103 - synthetic readable canary tests Landlock, not DAC  # nosec B103
        # Guard requires task scratch directly below verified tmpfs, matching
        # production MemoryScratch rather than a caller-selected mount.
        with tempfile.TemporaryDirectory(prefix="browser-task-", dir="/dev/shm") as task:  # noqa: S108  # nosec B108
            task_path = Path(task)
            os.chown(task_path, 10002, 10002)
            canary = root / "synthetic-agent-secret"
            canary.write_bytes(os.urandom(32))
            canary.chmod(0o644)
            parent, child = socket.socketpair()
            external = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            external.bind("\0" + task_path.name)
            external.settimeout(0.1)
            process = None
            try:
                parent.settimeout(65)
                process = subprocess.Popen(  # noqa: S603 - fixed module, UID, environment and private FD
                    [
                        sys.executable,
                        "-m",
                        __spec__.name,
                        "--child-fd",
                        str(child.fileno()),
                        "--scratch",
                        str(task_path),
                        "--canary",
                        str(canary),
                    ]
                    + ([] if chromium else ["--guards-only"]),
                    user=10002,
                    group=10002,
                    extra_groups=[],
                    env={
                        "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
                        "PYTHONPATH": "/opt/browser",
                        "PYTHONDONTWRITEBYTECODE": "1",
                    },
                    cwd="/opt/browser",
                    pass_fds=(child.fileno(),),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                child.close()
                result = _receive_result(parent)
                process.wait(timeout=5)
                result["worker_exited"] = process.returncode == 0
                try:
                    external.recv(64)
                    result["external_unix_datagram_denied"] = False
                except TimeoutError:
                    pass
            except Exception:
                result = {"code": "BROWSER_PROCESS_PROBE_REFUSED", "guard_verified": False}
            finally:
                child.close()
                parent.close()
                external.close()
                if process is not None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
    result["scratch_removed"] = not root.exists() and not task_path.exists()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child-fd", type=int)
    parser.add_argument("--scratch", type=Path)
    parser.add_argument("--canary", type=Path)
    parser.add_argument("--guards-only", action="store_true")
    arguments = parser.parse_args()
    if arguments.child_fd is not None:
        result = _inside(
            arguments.child_fd,
            arguments.scratch,
            arguments.canary,
            chromium=not arguments.guards_only,
        )
        with socket.socket(fileno=arguments.child_fd) as bridge:
            bridge.sendall(json.dumps(result, allow_nan=False).encode())
        return
    print(
        "HUSSH_BUILTIN_BROWSER_PROBE:" + json.dumps(run_probe(chromium=not arguments.guards_only)),
        flush=True,
    )


if __name__ == "__main__":
    main()
