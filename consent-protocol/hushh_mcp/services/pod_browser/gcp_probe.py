"""Controlled native sandbox probe; never an owner-pod upgrade or browser grant."""

from __future__ import annotations

import asyncio
import errno
import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path


async def _inside(directory: Path) -> dict:
    from .worker_identity import prepare_worker_identity

    prepare_worker_identity()
    from playwright.async_api import async_playwright

    # Deliberately synthetic. No login, provider key, website cookies or vault.
    challenge = (directory / "challenge").read_text()
    (directory / "receipt").write_text(challenge)
    blocked = []
    host_port = int((directory / "host-port").read_text())
    for label, host, port in (
        ("launcher_loopback", "127.0.0.1", host_port),
        ("metadata", "169.254.169.254", 80),
        ("direct_public", "1.1.1.1", 443),
    ):
        try:
            with socket.create_connection((host, port), timeout=2):
                blocked.append((label, False))
        except OSError as exc:
            # A timeout or generic connection failure is not denial evidence.
            definitive = exc.errno in {errno.EPERM, errno.EACCES, errno.ENETUNREACH}
            if label == "launcher_loopback":
                # Host listener is known live, so a separate sandbox namespace
                # refusing it also proves that host loopback was not inherited.
                definitive = definitive or exc.errno == errno.ECONNREFUSED
            blocked.append((label, definitive))
    started = time.monotonic()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, chromium_sandbox=True)
        try:
            page = await browser.new_page(
                viewport={"width": 1280, "height": 720}, service_workers="block"
            )
            await page.set_content("<main><h1>Controlled browser probe</h1></main>")
            png = await page.screenshot(type="png")
            (directory / "frame.png").write_bytes(png)
        finally:
            await browser.close()
    return {
        "socket_attempts_denied": dict(blocked),
        "chromium_started": True,
        "startup_and_frame_ms": round((time.monotonic() - started) * 1000),
        "frame_bytes": len(png),
        "bridge_written": True,
    }


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--inside", type=Path)
    args = parser.parse_args()
    if args.inside is not None:
        try:
            result = asyncio.run(_inside(args.inside))
            (args.inside / "result.json").write_text(json.dumps(result))
            return 0
        except Exception:
            return 1
    launcher = Path("/usr/local/gcp/bin/sandbox")
    if not (os.getenv("K_SERVICE") or os.getenv("CLOUD_RUN_JOB")) or not launcher.is_file():
        print(json.dumps({"status": "unavailable", "code": "GCP_NATIVE_SANDBOX_REQUIRED"}))
        return 2
    with (
        socket.socket() as host_listener,
        tempfile.TemporaryDirectory(prefix="browser-probe-") as temporary,
    ):
        host_listener.bind(("127.0.0.1", 0))
        host_listener.listen(1)
        directory = Path(temporary)
        challenge = os.urandom(16).hex()
        (directory / "challenge").write_text(challenge)
        (directory / "host-port").write_text(str(host_listener.getsockname()[1]))
        # Only this synthetic scratch directory is shared, never /app, recovery,
        # secrets or credentials. No --allow-egress, no command from a caller.
        try:
            completed = subprocess.run(  # noqa: S603 - fixed native probe, no caller command
                [
                    str(launcher),
                    "do",
                    "--write",
                    "--workdir",
                    "/opt/browser",
                    "--mount",
                    f"type=bind,source={directory},destination={directory}",
                    "--",
                    "/opt/venv/bin/python",
                    "-m",
                    __spec__.name,
                    "--inside",
                    str(directory),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
                check=False,
            )
            result = json.loads((directory / "result.json").read_text())
            png = (directory / "frame.png").read_bytes()
            success = (
                completed.returncode == 0
                and (directory / "receipt").read_text() == challenge
                and png.startswith(b"\x89PNG\r\n\x1a\n")
                and all(result["socket_attempts_denied"].values())
            )
        except Exception:
            print(json.dumps({"status": "failed", "code": "GCP_SANDBOX_PROBE_FAILED"}))
            return 1
        print(json.dumps({"status": "passed" if success else "failed", **result}))
        return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
