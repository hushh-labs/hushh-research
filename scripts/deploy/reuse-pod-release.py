#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Reuse one archived dev pod image without changing its source provenance."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Load only the shared stdlib Browser contract, without importing the pod SDK.
sys.path.insert(0, str(ROOT / "consent-protocol"))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("pod release contract is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


contract = load_module(
    "pod_release_contract", ROOT / "consent-protocol/hushh_mcp/services/pod_release.py"
)
resolver = load_module(
    "pod_image_resolver", ROOT / "scripts/ci/resolve-cloud-run-image.py"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


def validate_pin(value: object, *, project: str) -> dict:
    if (
        project != "hushh-pda-dev"
        or not isinstance(value, dict)
        or set(value) != {"image", "sourceRevision", "runId", "archiveSha256"}
    ):
        raise ValueError("pod reuse requires a reviewed dev publication pin")
    for field, pattern in (
        (
            "image",
            rf"gcr\.io/{re.escape(project)}/consent-protocol-pod@sha256:[0-9a-f]{{64}}",
        ),
        ("sourceRevision", r"[0-9a-f]{40}"),
        ("runId", r"[1-9][0-9]{0,19}"),
        ("archiveSha256", r"[0-9a-f]{64}"),
    ):
        if not isinstance(value[field], str) or not re.fullmatch(pattern, value[field]):
            raise ValueError("invalid pod publication pin")
    return value


def validate_archive(pin: dict, raw: bytes, *, project: str) -> dict:
    pin = validate_pin(pin, project=project)
    if (
        len(raw) > contract.MAX_RELEASE_BYTES
        or hashlib.sha256(raw).hexdigest() != pin["archiveSha256"]
    ):
        raise ValueError("archived pod publication checksum mismatch")
    release = contract.validate_release(
        json.loads(raw), target_image=pin["image"], environment="dev"
    )
    if (
        release["image"] != pin["image"]
        or release["sourceRevision"] != pin["sourceRevision"]
        or release["publisher"]["runId"] != pin["runId"]
    ):
        raise ValueError("archived pod publication provenance mismatch")
    return release


def gcloud(*args: str) -> bytes:
    result = subprocess.run(  # noqa: S603 -- fixed CLI; callers supply only validated operator arguments.
        ["gcloud", *args], capture_output=True, timeout=60, check=False
    )
    if result.returncode:
        raise ValueError("dev publication or image access refused")
    return result.stdout


def require_unchanged_image_context(pin: dict, descriptor_sha: str) -> None:
    """Metadata reuse cannot omit changes copied into the owner image.

    Compare protocol, generated contracts and upload rules conservatively.
    This runs in the main-owned workflow checkout before its Git-free Cloud Build
    upload; a direct Cloud Build reuse is not a supported release entrypoint.
    """
    result = subprocess.run(
        [
            "git",
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            pin["sourceRevision"],
            descriptor_sha,
            "--",
            "consent-protocol",
            "contracts",
            ".gcloudignore",
        ],
        cwd=ROOT,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise ValueError(
            "pod image inputs changed; remove the reuse pin and build the candidate"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--descriptor-sha", required=True)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--check-source-only", action="store_true")
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", args.descriptor_sha):
            raise ValueError("reviewed descriptor requires an exact source revision")
        pin = validate_pin(json.loads(args.config.read_text()), project=args.project)
        if args.check_source_only or (ROOT / ".git").exists():
            require_unchanged_image_context(pin, args.descriptor_sha)
        if args.check_source_only:
            print("Pinned pod image inputs match the candidate.")
            return 0
        if args.workspace is None:
            raise ValueError("pod publication workspace is required")
        archive = f"gs://{args.project}_cloudbuild/pod-releases/{pin['sourceRevision']}/{pin['runId']}/release.json"
        release = validate_archive(
            pin, gcloud("storage", "cat", archive), project=args.project
        )
        token = gcloud("auth", "print-access-token").decode().strip()
        digest = pin["image"].rsplit("@", 1)[1]
        request = urllib.request.Request(
            f"https://gcr.io/v2/{args.project}/consent-protocol-pod/manifests/{digest}",
            headers={
                "Authorization": "Bearer " + token,
                "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
            },
        )
        with urllib.request.build_opener(NoRedirect()).open(
            request, timeout=30
        ) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("pod image manifest exceeds its bound")
        resolved = resolver.resolve_manifest(raw, digest)
        if resolved != {"digest": digest, "selection": "direct_manifest"}:
            raise ValueError("archive must name the original executable pod manifest")
        args.workspace.mkdir(parents=True, exist_ok=True)
        (args.workspace / "pod-image-reference").write_text(release["image"] + "\n")
        (args.workspace / "pod-image-source-sha").write_text(
            release["sourceRevision"] + "\n"
        )
        (args.workspace / "pod-image-manifest.json").write_bytes(raw)
        provenance = {
            "status": "pinned",
            "image_reference": release["image"],
            "sha": release["sourceRevision"],
            "selection": "direct_manifest",
            "reusedPublication": {
                "runId": pin["runId"],
                "archiveSha256": pin["archiveSha256"],
            },
            "descriptorSourceRevision": args.descriptor_sha,
        }
        (args.workspace / "pod-image-provenance.json").write_text(
            json.dumps(provenance, indent=2) + "\n"
        )
    except Exception as exc:
        # Tokens never enter exception text or build logs.
        print(
            "Cannot reuse dev pod publication: " + type(exc).__name__, file=sys.stderr
        )
        return 1
    print("Reused the pinned dev pod image with its original source provenance.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
