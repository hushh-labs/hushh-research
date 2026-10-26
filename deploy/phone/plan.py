# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Select and revalidate one phone-aware rollback target before promotion."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

import qualify_image
from consumer_compatibility import qualify_consumers
from production_receipt import qualify_release
from revision_qualification import (
    PROJECT,
    REGION,
    SERVICE,
    cloud_document,
    inspect_cold,
    inspect_existing,
)


def _source_supported(sha: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        return False
    for command in (
        ["git", "merge-base", "--is-ancestor", sha, "origin/main"],
        [
            "python3",
            "deploy/account-deletion/activate_release.py",
            "--qualify-rollback-source",
            sha,
        ],
    ):
        if subprocess.run(
            command, capture_output=True, timeout=30, check=False
        ).returncode:  # noqa: S603
            return False
    return True


def _outputs(path: Path, **values: str) -> None:
    if any("\n" in value or "\r" in value for value in values.values()):
        raise ValueError("phone_rollback_output_invalid")
    with path.open("a") as output:
        output.writelines(f"{key}={value}\n" for key, value in values.items())


def _existing(revision: dict, directory: Path) -> dict | None:
    labels = (revision.get("metadata") or {}).get("labels") or {}
    sha = str(labels.get("deploy-sha") or "")
    if not _source_supported(sha):
        return None
    name = revision["metadata"]["name"]
    image = (revision.get("status") or {}).get("imageDigest")
    if (revision.get("spec") or {}).get(
        "serviceAccountName"
    ) != f"{SERVICE}-runtime@{PROJECT}.iam.gserviceaccount.com":
        raise ValueError("phone_rollback_existing_runtime_identity_invalid")
    production = qualify_release(
        run_id=labels.get("github-run-id", ""), sha=sha, revision=name
    )
    inspected = inspect_existing(
        revision_name=name,
        sha=sha,
        image=image,
        run_id=labels.get("github-run-id", ""),
        source=labels.get("deploy-source", ""),
    )
    qualify_image.run(
        [
            "python3",
            "scripts/ci/verify-cloudrun-revision-provenance.py",
            "--project",
            PROJECT,
            "--region",
            REGION,
            "--service",
            SERVICE,
            "--expected-env",
            "production",
            "--expected-source",
            labels["deploy-source"],
            "--expected-sha",
            sha,
            "--expected-run-id",
            labels["github-run-id"],
            "--candidate-revision",
            name,
            "--expected-image-reference",
            image,
            "--report-path",
            str(directory / "phone-rollback-existing-provenance.json"),
        ]
    )
    return {
        "mode": "existing",
        "revision": name,
        "source": sha,
        "image": image,
        "probe": qualify_image.qualify(sha, image),
        "production": production,
        "runtime": inspected,
    }


def _independent(sha: str, tools: Path, directory: Path) -> dict:
    if not _source_supported(sha):
        raise ValueError("phone_rollback_requires_a_main_phone425_source")
    accepted = directory / "phone-rollback-predecessor-acceptance.json"
    qualify_image.run(
        [
            "python3",
            str(tools / "verify-predecessor-acceptance.py"),
            "require",
            "--environment",
            "uat",
            "--scope",
            "backend",
            "--sha",
            sha,
            "--output",
            str(accepted),
        ],
        timeout=240,
    )
    receipt = json.loads(accepted.read_text())
    if (receipt.get("status"), receipt.get("environment"), receipt.get("sha")) != (
        "accepted",
        "uat",
        sha,
    ):
        raise ValueError("phone_rollback_predecessor_identity_invalid")
    source_image = receipt["services"]["backend"]["image_reference"]
    if not re.fullmatch(
        r"gcr\.io/hushh-pda-uat/consent-protocol@sha256:[0-9a-f]{64}", source_image
    ):
        raise ValueError("phone_rollback_predecessor_image_invalid")
    tag = f"gcr.io/{PROJECT}/{SERVICE}:phone-rollback-{sha}"
    qualify_image.run(
        ["gcloud", "container", "images", "add-tag", "--quiet", source_image, tag]
    )
    digest = (
        qualify_image.run(
            [
                "gcloud",
                "container",
                "images",
                "describe",
                tag,
                f"--project={PROJECT}",
                "--format=value(image_summary.digest)",
            ]
        )
        .decode()
        .strip()
    )
    if digest != source_image.split("@", 1)[1]:
        raise ValueError("phone_rollback_copied_digest_mismatch")
    image = f"gcr.io/{PROJECT}/{SERVICE}@{digest}"
    return {
        "mode": "cold",
        "source": sha,
        "image": image,
        "probe": qualify_image.qualify(sha, image),
        "predecessor": receipt,
    }


def _readers_qualified() -> bool:
    revisions = json.loads(
        qualify_image.run(
            [
                "gcloud",
                "run",
                "revisions",
                "list",
                f"--project={PROJECT}",
                f"--region={REGION}",
                f"--service={SERVICE}",
                "--format=json",
            ]
        )
    )
    return bool(revisions) and all(
        _source_supported(
            row.get("metadata", {}).get("labels", {}).get("deploy-sha", "")
        )
        for row in revisions
    )


def prepare(args) -> dict:
    current = json.loads(args.current_json.read_text())
    chosen = _existing(current, args.output.parent)
    if chosen is None:
        chosen = _independent(args.fallback_sha, args.release_tools, args.output.parent)
    elif args.fallback_sha:
        raise ValueError("phone_rollback_independent_source_unnecessary")
    if chosen["mode"] == "cold" and chosen["source"] == args.primary_sha:
        raise ValueError("phone_rollback_requires_independent_source")
    compatibility = qualify_consumers(chosen["source"], args.primary_sha)
    recovery_enabled = args.enable_recovery == "true" and _readers_qualified()
    plan = {
        "schema_version": 1,
        "run_id": args.run_id,
        "primary_sha": args.primary_sha,
        "consumer_compatibility": compatibility,
        "recovery_enabled": recovery_enabled,
        **chosen,
    }
    args.output.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
    _outputs(
        args.github_output,
        fallback_sha=plan["source"] if plan["mode"] == "cold" else "",
        fallback_image=plan["image"] if plan["mode"] == "cold" else "",
        recovery_enabled=str(recovery_enabled).lower(),
    )
    return plan


def verify(args) -> dict:
    plan = json.loads(args.plan.read_text())
    probe = plan.get("probe") or {}
    expected_probe = hashlib.sha256(
        (Path(__file__).parent / "reader_probe.py").read_bytes()
    ).hexdigest()
    if (
        plan.get("schema_version") != 1
        or plan.get("run_id") != args.run_id
        or plan.get("primary_sha") != args.primary_sha
        or not _source_supported(plan.get("source", ""))
        or probe.get("source") != plan.get("source")
        or probe.get("image") != plan.get("image")
        or probe.get("probe_sha256") != expected_probe
        or probe.get("phone_reader") != qualify_image.EXPECTED
        or probe.get("probe_generation_admission") is not False
        or plan.get("consumer_compatibility")
        != qualify_consumers(plan.get("source", ""), args.primary_sha)
        or type(plan.get("recovery_enabled")) is not bool
        or (plan.get("recovery_enabled") is True and not _readers_qualified())
    ):
        raise ValueError("phone_rollback_preparation_evidence_mismatch")
    if plan["mode"] == "cold":
        qualified = inspect_cold(
            sha=plan["source"], image=plan["image"], run_id=args.run_id
        )
    elif plan["mode"] == "existing":
        checked = _existing(
            cloud_document("revisions", plan["revision"]), args.output.parent
        )
        if checked is None or any(
            checked[key] != plan[key] for key in ("source", "image", "revision")
        ):
            raise ValueError("phone_rollback_existing_revision_changed")
        qualified = {key: checked[key] for key in ("revision", "source", "image")}
    else:
        raise ValueError("phone_rollback_mode_invalid")
    result = {
        "schema_version": 1,
        "run_id": args.run_id,
        "qualification": "passed",
        "project": PROJECT,
        "region": REGION,
        **qualified,
        "probe": probe,
    }
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    _outputs(args.github_output, revision=result["revision"])
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "verify"))
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--primary-sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    parser.add_argument("--current-json", type=Path)
    parser.add_argument("--fallback-sha", default="")
    parser.add_argument("--enable-recovery", choices=("true", "false"), default="false")
    parser.add_argument("--release-tools", type=Path)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[1-9][0-9]*", args.run_id):
            raise ValueError("phone_rollback_run_identity_invalid")
        if not re.fullmatch(r"[0-9a-f]{40}", args.primary_sha):
            raise ValueError("phone_rollback_primary_identity_invalid")
        (prepare if args.command == "prepare" else verify)(args)
    except (
        ValueError,
        TypeError,
        KeyError,
        AttributeError,
        OSError,
        subprocess.SubprocessError,
    ) as exc:
        print(f"Phone rollback qualification refused: {type(exc).__name__}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
