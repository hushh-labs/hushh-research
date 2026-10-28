"""Pure contracts for Main-owned PLG frontend source validation."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re

_spec = importlib.util.spec_from_file_location(
    "plg_frontend_source_authority", Path(__file__).with_name("frontend_source.py")
)
if not _spec or not _spec.loader:
    raise RuntimeError("PLG frontend source authority unavailable")
source = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(source)
require = source.require

REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/validate-plg-frontend-source.yml"
WORKFLOW_NAME = "validate-plg-frontend-source.yml"
TITLE = f"PLG frontend source {source.SOURCE_SHA}"
GATE = "PLG Frontend Source Validation Gate"
PAGE_SIZE = 100
MAX_RUNS = 2000
CHECKS = [
    "source-identity",
    "protected-security",
    "source-secret-scan",
    "source-dco",
    "canonical-web-core",
    "back-hierarchy",
    "plg-privacy-account",
    "source-recheck",
]
JOB_STEPS = {
    "Admit PLG frontend source": {
        "Require Main workflow dispatch",
        "Checkout Main authority",
        "Require governed production actors",
        "Install locked authority Python",
        "Run authority contract tests",
        "Fetch pinned frontend source",
        "Verify source and protected security",
        "Scan source changes for secrets",
        "Verify source DCO signoffs",
        "Upload admission receipt",
    },
    "Verify frontend candidate": {
        "Checkout pinned frontend source",
        "Verify source checkout",
        "Set up Node 24",
        "Set up Python 3.13",
        "Run canonical web core",
        "Run Back hierarchy",
        "Run PLG privacy and account tests",
        "Write test report",
        "Verify source after tests",
        "Upload frontend test report",
    },
    GATE: {
        "Checkout Main authority",
        "Require successful predecessors",
        "Fetch pinned frontend source",
        "Recheck source and protected security",
        "Upload source validation receipt",
    },
}


def _same_json(left: object, right: object) -> bool:
    try:
        return json.dumps(
            left, sort_keys=True, separators=(",", ":"), allow_nan=False
        ) == json.dumps(right, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError):
        return False


def _positive(value: object) -> bool:
    return type(value) is int and value > 0


def qualify_run(
    run: dict, workflow: dict, run_id: int, allowed: set[str], *, completed: bool = True
) -> None:
    repo = run.get("repository") or {}
    head_repo = run.get("head_repository") or {}
    require(
        _positive(run_id)
        and _positive(run.get("id"))
        and run.get("id") == run_id
        and run.get("path") == WORKFLOW
        and run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == "main"
        and run.get("display_title") == TITLE
        and repo.get("full_name") == REPOSITORY
        and head_repo.get("full_name") == REPOSITORY
        and _positive(repo.get("id"))
        and repo.get("id") == head_repo.get("id")
        and _positive(workflow.get("id"))
        and _positive(run.get("workflow_id"))
        and run.get("workflow_id") == workflow.get("id")
        and workflow.get("path") == WORKFLOW
        and _positive(run.get("run_attempt"))
        and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", ""))
        and run.get("actor", {}).get("login") in allowed
        and run.get("triggering_actor", {}).get("login") in allowed,
        "Frontend validation is not a governed Main workflow dispatch",
    )
    if completed:
        require(
            run.get("status") == "completed" and run.get("conclusion") == "success",
            "Frontend validation did not succeed",
        )
    else:
        require(
            run.get("status") == "in_progress", "Frontend validation is not in progress"
        )


def qualify_jobs(inventory: dict, run: dict) -> None:
    jobs = inventory.get("jobs")
    require(
        type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(JOB_STEPS)
        and isinstance(jobs, list)
        and len(jobs) == len(JOB_STEPS),
        "Frontend job inventory is incomplete",
    )
    require(all(isinstance(job, dict) for job in jobs), "Invalid frontend job")
    require(
        {job.get("name") for job in jobs} == set(JOB_STEPS),
        "Frontend job identities changed",
    )
    for job in jobs:
        require(
            _positive(job.get("run_id"))
            and job.get("run_id") == run["id"]
            and job.get("head_sha") == run["head_sha"]
            and job.get("status") == "completed"
            and job.get("conclusion") == "success",
            "Frontend job did not pass",
        )
        steps = job.get("steps") or []
        required = JOB_STEPS[job["name"]]
        selected = [step for step in steps if step.get("name") in required]
        require(
            len(selected) == len(required)
            and {step["name"] for step in selected} == required
            and all(
                step.get("status") == "completed"
                and step.get("conclusion") == "success"
                for step in selected
            ),
            "Frontend required step was missing, duplicated, skipped or failed",
        )


def select_artifact(inventory: dict, run: dict, prefix: str, max_bytes: int) -> dict:
    rows = inventory.get("artifacts")
    require(
        isinstance(rows, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(rows) <= 100,
        "Frontend artifact inventory is incomplete",
    )
    require(all(isinstance(item, dict) for item in rows), "Invalid frontend artifact")
    name = f"{prefix}-{run['id']}-{run['run_attempt']}"
    matches = [item for item in rows if item.get("name") == name]
    require(len(matches) == 1, "Frontend artifact is missing or ambiguous")
    item = matches[0]
    require(
        item.get("expired") is False
        and _positive(item.get("id"))
        and _positive(item.get("workflow_run", {}).get("id"))
        and item.get("workflow_run", {}).get("id") == run["id"]
        and _positive(item.get("size_in_bytes"))
        and item["size_in_bytes"] <= max_bytes
        and re.fullmatch(r"sha256:[0-9a-f]{64}", item.get("digest", "")) is not None,
        "Frontend artifact integrity is invalid",
    )
    return item


def qualify_test_report(report: dict, sha: str) -> None:
    require(
        report
        == {
            "schemaVersion": 1,
            "sourceSha": sha,
            "back": {"files": 16, "passed": 494, "failed": 0, "pending": 0},
            "privacy": {"files": 4, "passed": 119, "failed": 0, "pending": 0},
        }
        and type(report.get("schemaVersion")) is int
        and all(
            type(value) is int
            for key in ("back", "privacy")
            for value in report[key].values()
        ),
        "Frontend test report is incomplete or not exact-source",
    )


def _receipt(
    run: dict,
    admitted: dict,
    admission_artifact: dict,
    test_artifact: dict,
    report: dict,
) -> dict:
    return {
        "schemaVersion": 1,
        "status": "passed",
        "repository": REPOSITORY,
        "workflowSha": run["head_sha"],
        "sourceSha": admitted["sourceSha"],
        "baselineSha": admitted["baselineSha"],
        "recordSha256": admitted["recordSha256"],
        "backendRecordSha256": admitted["backendRecordSha256"],
        "authorityFiles": admitted["authorityFiles"],
        "security": admitted["security"],
        "runId": run["id"],
        "runAttempt": run["run_attempt"],
        "admissionArtifact": {
            "id": admission_artifact["id"],
            "digest": admission_artifact["digest"],
        },
        "testArtifact": {"id": test_artifact["id"], "digest": test_artifact["digest"]},
        "testReport": report,
        "checks": CHECKS,
        "sourceQualified": True,
        "trafficAuthorized": False,
        "environmentAccepted": False,
        "customerSendingAuthorized": False,
    }
