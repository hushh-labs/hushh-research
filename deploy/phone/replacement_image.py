# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Build an explicitly selected Main rollback with the primary's runtime bytes."""

from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

import qualify_image

ROOT = Path(__file__).resolve().parents[2]


def same_backend(fallback: str, primary: str) -> bool:
    if any(not re.fullmatch(r"[a-f0-9]{40}", sha) for sha in (fallback, primary)):
        raise ValueError("phone_rollback_backend_source_invalid")
    ignored = (
        qualify_image.run(
            [
                "git",
                "show",
                f"{fallback}:consent-protocol/.dockerignore",
            ]
        )
        .decode()
        .splitlines()
    )
    ignored = [line.strip() for line in ignored]
    allowed_negations = {"!hushh_mcp/agents/*.md", "!hushh_mcp/agents/**/*.md"}
    if "tests/" not in ignored or any(
        line.startswith("!") and line not in allowed_negations for line in ignored
    ):
        raise ValueError("phone_rollback_test_exclusion_unproven")
    result = subprocess.run(  # noqa: S603
        [
            "git",
            "diff",
            "--quiet",
            fallback,
            primary,
            "--",
            "consent-protocol",
            "contracts",
            ":(exclude)consent-protocol/tests",
        ],
        cwd=ROOT,
        check=False,
        timeout=30,
    )
    if result.returncode not in (0, 1):
        raise ValueError("phone_rollback_backend_comparison_failed")
    return result.returncode == 0


def recheck_main_source(source: str, tools: Path, directory: Path, prior=None) -> dict:
    if tools is None:
        raise ValueError("phone_rollback_main_tools_required")
    output = directory / "phone-rollback-main-acceptance.json"
    application = source
    parents = (
        qualify_image.run(["git", "show", "-s", "--format=%P", source]).decode().split()
    )
    if len(parents) == 2:
        source_tree = qualify_image.run(
            ["git", "rev-parse", f"{source}^{{tree}}"]
        ).strip()
        parent_tree = qualify_image.run(
            ["git", "rev-parse", f"{parents[1]}^{{tree}}"]
        ).strip()
        if source_tree == parent_tree:
            application = parents[1]
    command = [
        "python3",
        str(tools / "verify-predecessor-acceptance.py"),
        "main-source",
        "--environment",
        "production",
        "--scope",
        "backend",
        "--sha",
        application,
        "--approval-sha",
        source,
        "--output",
        str(output),
    ]
    if prior is not None:
        # The verifier reads the prior before writing the new record.
        output.write_text(json.dumps(prior))
        command += ["--predecessor", str(output)]
    qualify_image.run(command, timeout=240)
    receipt = json.loads(output.read_text())
    if (
        receipt.get("kind") != "main-qualified-source"
        or receipt.get("status") != "qualified"
        or receipt.get("environment") != "production"
        or receipt.get("sha") != application
        or receipt.get("main_approval_sha") != source
        or receipt.get("resolved_services") != ["backend"]
    ):
        raise ValueError("phone_rollback_main_source_unqualified")
    return receipt


def qualify_replacement_image(source: str, tools: Path, directory: Path) -> dict:
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("phone_rollback_replacement_source_invalid")
    receipt = recheck_main_source(source, tools, directory)
    tag = "phone-rollback-" + source
    with tempfile.TemporaryDirectory(prefix="phone-rollback-source-") as temporary:
        workspace = Path(temporary)
        archive, checkout = workspace / "source.tar", workspace / "app"
        checkout.mkdir()
        qualify_image.run(
            ["git", "archive", "--format=tar", f"--output={archive}", source],
        )
        with tarfile.open(archive) as contents:
            contents.extractall(checkout, filter="data")
        shutil.copyfile(ROOT / ".gcloudignore", checkout / ".gcloudignore")
        build = json.loads(
            qualify_image.run(
                [
                    "gcloud",
                    "builds",
                    "submit",
                    str(checkout),
                    "--project=hushh-pda",
                    f"--config={ROOT / 'deploy/backend-image.cloudbuild.yaml'}",
                    f"--substitutions=_IMAGE_TAG={tag}",
                    "--async",
                    "--suppress-logs",
                    "--format=json",
                ],
                timeout=240,
            )
        )
    if build.get("projectId") != "hushh-pda" or not re.fullmatch(
        r"[a-f0-9-]{36}", build.get("id", "")
    ):
        raise ValueError("phone_rollback_image_build_failed")
    build_file = directory / "phone-rollback-image-build.json"
    build_file.write_text(json.dumps(build))
    deadline = time.monotonic() + 2400
    try:
        while build.get("status") in {"QUEUED", "PENDING", "WORKING"}:
            if time.monotonic() >= deadline:
                raise TimeoutError("phone_rollback_image_build_timeout")
            time.sleep(10)
            observed = json.loads(
                qualify_image.run(
                    [
                        "gcloud",
                        "builds",
                        "describe",
                        build["id"],
                        "--project=hushh-pda",
                        "--format=json",
                    ],
                    timeout=90,
                )
            )
            if (
                observed.get("id") != build["id"]
                or observed.get("projectId") != "hushh-pda"
            ):
                raise ValueError("phone_rollback_image_build_identity_changed")
            build = observed
            build_file.write_text(json.dumps(build))
    except BaseException:
        qualify_image.run(
            [
                "gcloud",
                "builds",
                "cancel",
                build["id"],
                "--project=hushh-pda",
                "--quiet",
            ],
            timeout=90,
        )
        raise
    if build.get("status") != "SUCCESS":
        raise ValueError("phone_rollback_image_build_failed")
    indexes = [
        i
        for i, step in enumerate(build.get("steps", []))
        if step.get("id") == "record-backend-image" and step.get("status") == "SUCCESS"
    ]
    if len(indexes) != 1:
        raise ValueError("phone_rollback_image_output_missing")
    outputs = build.get("results", {}).get("buildStepOutputs", [])
    if len(outputs) <= indexes[0] or len(outputs[indexes[0]]) > 5500:
        raise ValueError("phone_rollback_image_output_invalid")
    native = json.loads(base64.b64decode(outputs[indexes[0]], validate=True))
    if (
        not isinstance(native, dict)
        or set(native) != {"kind", "imageTag", "indexDigest", "platform"}
        or native.get("kind") != "backend-image-build-output-v1"
        or native.get("imageTag") != tag
        or native.get("platform") != "linux/amd64"
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", native.get("indexDigest", ""))
    ):
        raise ValueError("phone_rollback_image_output_invalid")
    index = "gcr.io/hushh-pda/consent-protocol@" + native["indexDigest"]
    manifest = directory / "phone-rollback-built-manifest.json"
    manifest.write_bytes(
        qualify_image.run(
            ["docker", "buildx", "imagetools", "inspect", "--raw", index],
        )
    )
    image = (
        qualify_image.run(
            [
                "python3",
                str(ROOT / "scripts/ci/resolve-cloud-run-image.py"),
                "--image-reference",
                index,
                "--manifest-json",
                str(manifest),
                "--json-output",
                str(directory / "phone-rollback-built-image.json"),
                "--sha",
                source,
            ]
        )
        .decode()
        .strip()
    )
    probe = qualify_image.qualify(source, image)
    recheck_main_source(source, tools, directory, receipt)
    (directory / "phone-rollback-image-build.json").write_text(json.dumps(build))
    return {
        "mode": "cold",
        "source": source,
        "image": image,
        "probe": probe,
        "predecessor": receipt,
        "build_id": build["id"],
    }
