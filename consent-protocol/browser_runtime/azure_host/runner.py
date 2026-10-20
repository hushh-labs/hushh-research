"""Fixed owner pod supervisor; no arbitrary executable or runtime overrides."""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
from uuid import uuid4

from .config import (
    APPARMOR_SHA256,
    DOCKER_VERSION,
    ROOT,
    RUNTIME,
    SECCOMP_SHA256,
    HostRefused,
    load,
    protected_read,
)
from .credentials import prepare_signing_secret, pull, require_vm
from .engine import NAME, clean, command, create, docker, failure_summary, remove_stopped
from .tls import ensure


def event(stage: str, **metadata) -> None:
    # Only authored stage/error codes and bounded numeric process observations.
    print("HUSSH_HOST:" + json.dumps({"stage": stage, **metadata}), file=sys.stderr, flush=True)


def _prepare() -> dict:
    if os.geteuid() != 0:
        raise HostRefused("HOST_ROOT_REQUIRED")
    config = load()
    event("installation_loaded")
    if command("dpkg-query", "-W", "-f=${Version}", "docker.io").decode() != DOCKER_VERSION:
        raise HostRefused("HOST_RUNTIME_VERSION_CHANGED")
    for path in ("/run", "/dev/shm"):  # noqa: S108 - verified tmpfs, not disk temporary storage
        if command("findmnt", "-n", "-o", "FSTYPE", "--target", path).strip() != b"tmpfs":
            raise HostRefused("HOST_MEMORY_STORAGE_REQUIRED")
    if (
        hashlib.sha256(protected_read(ROOT / "seccomp.json", limit=131072)).hexdigest()
        != SECCOMP_SHA256
    ):
        raise HostRefused("HOST_SECCOMP_POLICY_CHANGED")
    if (
        hashlib.sha256(protected_read(ROOT / "apparmor.profile", limit=16384)).hexdigest()
        != APPARMOR_SHA256
    ):
        raise HostRefused("HOST_APPARMOR_POLICY_CHANGED")
    require_vm(config)
    event("identity_verified")
    RUNTIME.mkdir(mode=0o755, exist_ok=True)
    os.chmod(RUNTIME, 0o755)  # noqa: S103 - non-secret, root-writable manifest directory must be traversable by UID 10001
    (RUNTIME / "pod.json").write_text(json.dumps(config["installation"]) + "\n")
    os.chmod(RUNTIME / "pod.json", 0o644)
    ensure(config)
    event("certificate_ready")
    pull(config)
    event("image_pulled")
    return config


def main() -> None:
    config = _prepare()
    remove_stopped(config)
    run_id = uuid4().hex
    try:
        prepare_signing_secret(config)
        event("signing_secret_ready")
        create(config, run_id)
        event("container_created")
        # No raw private application logs in host journal. Docker's root-only,
        # bounded local driver retains them for owner-authorized diagnostics.
        result = subprocess.run(  # noqa: S603 - fixed executable and validated installation values
            ["docker", "start", "--attach", NAME],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode or docker("inspect", NAME)["State"]["ExitCode"]:
            event("application_stopped")
            try:
                event("application_exit", **failure_summary(run_id))
            except Exception:
                event("application_diagnostic_unavailable")
            raise HostRefused("HOST_APPLICATION_STOPPED")
    except BaseException as exc:
        event(
            "execution_failed",
            code=str(exc)
            if isinstance(exc, HostRefused)
            else "HOST_UNEXPECTED_" + type(exc).__name__,
        )
        raise
    finally:
        clean(run_id)


def _stop(_signal, _frame) -> None:
    raise HostRefused("HOST_STOP_REQUESTED")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    try:
        main()
    except HostRefused as exc:
        event("refused", code=str(exc))
        raise SystemExit(1) from None
    except Exception as exc:
        # Never include provider bodies, raw logs or installation values.
        event("refused", code="HOST_UNEXPECTED_" + type(exc).__name__)
        raise SystemExit(1) from None
