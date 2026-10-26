# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bind an existing rollback revision to its successful production run artifact."""

from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path

from qualify_image import run

REPOSITORY = "hushh-labs/hushh-research"


def qualify_release(*, run_id: str, sha: str, revision: str) -> dict:
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("phone_rollback_production_run_invalid")
    authority = json.loads(
        run(["gh", "api", f"repos/{REPOSITORY}/actions/runs/{run_id}"])
    )
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
    if (
        receipt.get("status") != "healthy"
        or receipt.get("sha") != sha
        or receipt.get("final", {}).get("backend_revision") != revision
        or receipt.get("candidate", {}).get("backend_revision") != revision
    ):
        raise ValueError("phone_rollback_production_revision_not_accepted")
    refreshed = json.loads(
        run(["gh", "api", f"repos/{REPOSITORY}/actions/runs/{run_id}"])
    )
    if (
        refreshed.get("run_attempt") != authority["run_attempt"]
        or refreshed.get("status") != "completed"
        or refreshed.get("conclusion") != "success"
    ):
        raise ValueError("phone_rollback_production_attempt_changed")
    return {
        "run_id": run_id,
        "run_attempt": authority["run_attempt"],
        "artifact_id": rows[0]["id"],
        "source": sha,
        "revision": revision,
    }
