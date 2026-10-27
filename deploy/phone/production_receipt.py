# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bind an existing rollback revision to its successful production run artifact."""

from __future__ import annotations

import importlib
import json
import re
import sys
import tempfile
from pathlib import Path

from qualify_image import run

REPOSITORY = "hushh-labs/hushh-research"


def _authority(run_id: str) -> dict:
    return json.loads(run(["gh", "api", f"repos/{REPOSITORY}/actions/runs/{run_id}"]))


def _require_authority(authority: dict, run_id: str) -> None:
    if any(
        authority.get(key) != value
        for key, value in {
            "id": int(run_id),
            "status": "completed",
            "conclusion": "success",
            "event": "workflow_dispatch",
            "path": ".github/workflows/deploy-production.yml",
            "head_branch": "main",
        }.items()
    ):
        raise ValueError("phone_rollback_production_run_unqualified")


def _original_receipt(authority: dict, run_id: str) -> tuple[dict, dict]:
    inventory = json.loads(
        run(
            [
                "gh",
                "api",
                f"repos/{REPOSITORY}/actions/runs/{run_id}/artifacts?per_page=100",
            ]
        )
    )
    rows = [
        row
        for row in inventory.get("artifacts", [])
        if row.get("name") == f"prod-release-{run_id}" and row.get("expired") is False
    ]
    if (
        inventory.get("total_count", 101) > 100
        or len(rows) != 1
        or rows[0].get("created_at", "") < authority["run_started_at"]
    ):
        raise ValueError("phone_rollback_production_attempt_receipt_missing")
    with tempfile.TemporaryDirectory(prefix="phone-production-receipt-") as directory:
        run(
            [
                "gh",
                "run",
                "download",
                run_id,
                "--repo",
                REPOSITORY,
                "--name",
                rows[0]["name"],
                "--dir",
                directory,
            ]
        )
        receipt_file = Path(directory) / "prod-release-status.json"
        if receipt_file.stat().st_size > 1024 * 1024:
            raise ValueError("phone_rollback_production_receipt_exceeds_bound")
        receipt = json.loads(receipt_file.read_text())
    return receipt, rows[0]


def _continuation_owners():
    directory = str(Path(__file__).resolve().parents[2] / "scripts/ci")
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return tuple(
        importlib.import_module(name)
        for name in (
            "production_backend_successor_proof",
            "production_activation_continuation",
            "uat-retention-maintenance",
        )
    )


def _healthy_tag(proof, sha: str, revision: str) -> tuple[dict, str]:
    tag = proof.read_original()
    healthy, _operational = proof.reference.split(tag["message"], tag["commit"])
    fields = proof.reference.healthy_fields(healthy, tag["commit"])
    match = re.fullmatch(
        rf"https://github\.com/{re.escape(REPOSITORY)}/actions/runs/([1-9][0-9]*)",
        fields["run"],
    )
    if (
        tag["commit"] != sha
        or fields["backend_revision"] != revision
        or match is None
    ):
        raise ValueError("phone_rollback_production_healthy_reference_mismatch")
    return tag, match[1]


def _activated_continuation(authority: dict, artifact: dict, sha: str, revision: str):
    proof, continuation, owner = _continuation_owners()
    tag, healthy_run_id = _healthy_tag(proof, sha, revision)
    if healthy_run_id == str(authority["id"]):
        raise ValueError("phone_rollback_production_continuation_missing")
    current = owner.api(REPOSITORY, f"runs/{healthy_run_id}")
    _require_authority(current, healthy_run_id)
    lane = owner.LANES["production"]
    arguments = {
        "api": owner.api,
        "governed": owner.governed_dispatch,
        "timestamp": owner._github_timestamp,
        "run_command": owner.retention.run_command,
        "timeout": 30,
    }
    current_artifact, _job = continuation.receipts.current_attempt_artifact(
        REPOSITORY, current, lane, api=owner.api, timestamp=owner._github_timestamp
    )
    archive = continuation.receipts.immutable_archive(
        REPOSITORY, current_artifact, run_command=arguments["run_command"], timeout=30
    )
    release = continuation.phone._document(archive, "prod-release-status.json")
    context = continuation.archive_context(
        REPOSITORY, current, release, lane, **arguments
    )
    _require_continuation(context, authority, artifact, current_artifact, sha, revision)
    refreshed = owner.api(REPOSITORY, f"runs/{healthy_run_id}?exclude_pull_requests=true")
    if (
        any(
            refreshed.get(key) != current.get(key)
            for key in ("id", "run_attempt", "head_sha", "status", "conclusion")
        )
        or proof.read_original() != tag
    ):
        raise ValueError("phone_rollback_production_continuation_changed")
    return {
        "run_id": healthy_run_id,
        "run_attempt": current["run_attempt"],
        "artifact_id": current_artifact["id"],
        "artifact_digest": current_artifact["digest"],
        "healthy_tag": tag,
        "context": context,
    }


def _require_continuation(context, authority, artifact, current_artifact, sha, revision):
    if (
        context is None
        or context["original"]["run_id"] != authority["id"]
        or context["original"]["run_attempt"] != authority["run_attempt"]
        or context["original"]["artifact_id"] != artifact["id"]
        or context["backend"]["run_id"] != authority["id"]
        or context["backend"]["sha"] != sha
        or context["backend"]["source"] != sha
        or context["backend"]["revision"] != revision
        or context["cold_rollback"]["artifact_id"] != current_artifact["id"]
        or context["cold_rollback"]["artifact_digest"] != current_artifact["digest"]
    ):
        raise ValueError("phone_rollback_production_continuation_mismatch")


def qualify_release(*, run_id: str, sha: str, revision: str) -> dict:
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("phone_rollback_production_run_invalid")
    authority = _authority(run_id)
    _require_authority(authority, run_id)
    receipt, artifact = _original_receipt(authority, run_id)
    if (
        receipt.get("sha") != sha
        or receipt.get("final", {}).get("backend_revision") != revision
        or receipt.get("candidate", {}).get("backend_revision") != revision
    ):
        raise ValueError("phone_rollback_production_revision_not_accepted")
    activation = None
    if receipt.get("status") == "pending_activation":
        activation = _activated_continuation(authority, artifact, sha, revision)
    elif receipt.get("status") != "healthy":
        raise ValueError("phone_rollback_production_revision_not_accepted")
    refreshed = _authority(run_id)
    if (
        refreshed.get("run_attempt") != authority["run_attempt"]
        or refreshed.get("status") != "completed"
        or refreshed.get("conclusion") != "success"
    ):
        raise ValueError("phone_rollback_production_attempt_changed")
    return {
        "run_id": run_id,
        "run_attempt": authority["run_attempt"],
        "artifact_id": artifact["id"],
        "source": sha,
        "revision": revision,
        **({"activation_continuation": activation} if activation is not None else {}),
    }
