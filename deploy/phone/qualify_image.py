# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Qualify a pinned executable phone-reader image without cloud credentials in it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import selectors
import subprocess
import tempfile
import time
from pathlib import Path
from runpy import run_path
from uuid import uuid4

HERE = Path(__file__).resolve().parent
EXPECTED = {
    "retired": "AUTH_PHONE_ACCESS_REVOKED",
    "unfenced": "AUTH_INDEPENDENT_SIGN_IN_REQUIRED",
    "uninstalled": "AUTH_INDEPENDENT_SIGN_IN_REQUIRED",
    "unavailable": "AUTH_SESSION_STATUS_UNAVAILABLE",
    "fence_unavailable": "AUTH_SESSION_STATUS_UNAVAILABLE",
    "social": "admitted",
    "device_revoke_missing_proof": "DEVICE_ACTION_PROOF_REQUIRED",
}


def run(command: list[str], *, data: bytes | None = None, timeout: int = 120) -> bytes:
    group = run_path(str(HERE.parents[1] / "scripts/ci/process_group.py"))[
        "command_group"
    ]
    with tempfile.TemporaryFile() as source:
        source.write(data or b"")
        source.seek(0)
        with group(
            command, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        ) as (process, stop):
            result = bytearray()
            deadline = time.monotonic() + timeout
            try:
                with selectors.DefaultSelector() as ready:
                    ready.register(process.stdout, selectors.EVENT_READ)
                    while ready.get_map():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise subprocess.TimeoutExpired(command, timeout)
                        for key, _ in ready.select(min(remaining, 0.2)):
                            chunk = os.read(key.fd, 65536)
                            if not chunk:
                                ready.unregister(key.fileobj)
                            else:
                                result.extend(chunk)
                                if len(result) > 1024 * 1024:
                                    raise ValueError(
                                        "phone_image_evidence_exceeds_bound"
                                    )
                code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
                if code:
                    raise subprocess.CalledProcessError(code, command)
                return bytes(result)
            finally:
                stop()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    stop(force=True)
                    process.wait(timeout=5)
                process.stdout.close()


def probe(image: str) -> dict:
    name = "hushh-phone-reader-" + uuid4().hex
    command = [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=1g",
        "--cpus=1",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
        "--workdir=/app",
        "-i",
        "--env=PYTHONDONTWRITEBYTECODE=1",
        "--env=PYTHONOPTIMIZE=0",
        "--env=ENVIRONMENT=production",
        "--env=AUTH_PHONE_RECOVERY_ENABLED=false",
        "--env=WORKOS_SSO_ENABLED=false",
        "--env=DB_OFFLINE=1",
        "--env=GOOGLE_CLOUD_PROJECT=synthetic-phone-reader",
        "--env=APP_SIGNING_KEY=synthetic_phone_reader_key_32chars_minimum",
        "--env=VAULT_DATA_KEY=" + "0" * 64,
        "--entrypoint=python",
        image,
        "-",
    ]
    try:
        result = run(command, data=(HERE / "reader_probe.py").read_bytes(), timeout=180)
        payload = json.loads(result)
        if payload.get("schema_version") != 1 or (
            payload.get("phone_reader") != EXPECTED
            or payload.get("probe_generation_admission") is not False
        ):
            raise ValueError("phone_image_reader_verdict_invalid")
        return payload
    finally:
        # Timeout of docker's client does not prove that its container stopped.
        listing = [
            "docker",
            "container",
            "ls",
            "-a",
            "--filter",
            f"name=^/{name}$",
            "--format",
            "{{.ID}}",
        ]
        if run(listing, timeout=20).strip():
            run(["docker", "rm", "--force", name], timeout=20)
        if run(listing, timeout=20).strip():
            raise ValueError("phone_probe_container_cleanup_unproven")


def qualify(sha: str, image: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(
        r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", image
    ):
        raise ValueError("phone_image_identity_invalid")
    run(
        [
            "python3",
            "deploy/account-deletion/activate_release.py",
            "--qualify-rollback-source",
            sha,
        ]
    )
    raw = run(["docker", "buildx", "imagetools", "inspect", "--raw", image])
    manifest = json.loads(raw)
    if (
        manifest.get("mediaType")
        not in {
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
        }
        or "manifests" in manifest
    ):
        raise ValueError("phone_image_must_be_one_executable_manifest")
    payload = probe(image)
    sources = payload.get("source_sha256")
    expected_paths = {
        name.replace(".", "/") + ".py"
        for name in run_path(str(HERE / "reader_probe.py"))["SOURCE_MODULES"]
    }
    if not isinstance(sources, dict) or set(sources) != expected_paths:
        raise ValueError("phone_image_source_inventory_invalid")
    for name, digest in sources.items():
        expected = hashlib.sha256(
            run(["git", "show", f"{sha}:consent-protocol/{name}"])
        ).hexdigest()
        if digest != expected:
            raise ValueError("phone_image_packaged_source_mismatch")
    return {
        **payload,
        "source": sha,
        "image": image,
        "probe_sha256": hashlib.sha256(
            (HERE / "reader_probe.py").read_bytes()
        ).hexdigest(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        args.output.write_text(
            json.dumps(qualify(args.sha, args.image), indent=2, sort_keys=True) + "\n"
        )
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        print(f"Phone image qualification refused: {type(exc).__name__}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
