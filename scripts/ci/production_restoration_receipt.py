"""Qualify the recorded restoration as serving evidence, never a phone anchor."""

from __future__ import annotations

from datetime import timedelta
import hashlib
from io import BytesIO
import re
from runpy import run_path
import subprocess
import time
from zipfile import ZipFile

import production_phone_receipt as phone
import release_artifact_receipts as receipts

ROOT = phone.ROOT
STEPS = (
    "Admit recorded production restoration",
    "Prepare qualified phone rollback and producer stage",
    "Upload immutable recovery baseline",
    "Revalidate recovery baseline before runtime mutation",
    "Qualify current account lifecycle producer",
    "Qualify uninterrupted account deletion",
    "Deploy backend using Cloud Build",
    "Revalidate actual phone rollback after backend deployment attempt",
    "Verify backend candidate readiness and exact-SHA provenance",
    "Deploy frontend using Cloud Build",
    "Verify backend candidate runtime identity",
    "Verify recovery boundary immediately before traffic",
    "Promote deployed revisions to production traffic",
    "Verify production backend deployment provenance",
    "Verify production frontend deployment provenance",
    "Post-deploy backend runtime health gate",
    "Post-deploy frontend runtime health gate",
    "Verify production account-session contract",
    "Activate tombstone-aware account deletion",
    "Resolve final Cloud Run state",
    "Write production release status artifact",
)


def _require(condition, reason):
    if not condition:
        raise receipts.retention.UnsafeState("Restoration serving reference: " + reason)


def source_record(sha):
    """Reuse the canonical source/policy qualification without provider reads."""
    authority = run_path(
        str(ROOT / "deploy/account-deletion/compatibility_restoration.py")
    )
    try:
        record = authority["qualify_source"](sha)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise receipts.retention.UnsafeState(
            "Restoration source is not qualified"
        ) from error
    return record, hashlib.sha256(authority["RECORD"].read_bytes()).hexdigest()


def _origin(repository, run, release, lane, governed):
    _require(
        lane.get("project") == "hushh-pda"
        and run.get("path") == ".github/workflows/deploy-production.yml"
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and run.get("status") == "completed"
        and run.get("conclusion") in {"success", "failure"}
        and type(run.get("id")) is int
        and run["id"] > 0
        and type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        and governed(run, repository, "production")
        and re.fullmatch(r"[0-9a-f]{40}", str(release.get("sha", "")))
        and release.get("status") == "healthy"
        and release.get("scope") == "all",
        "origin or healthy paired release is invalid",
    )


def _gates(job, run):
    steps = job.get("steps")
    _require(
        isinstance(steps, list) and all(isinstance(s, dict) for s in steps),
        "job steps are incomplete",
    )
    names = {step.get("name"): step for step in steps}
    _require(
        job.get("conclusion") == run["conclusion"]
        and len(names) == len(steps)
        and all(
            names.get(name, {}).get("status") == "completed"
            and names[name].get("conclusion") == "success"
            for name in STEPS
        ),
        "required restoration gates did not pass",
    )


def _operation(repository, run, job, lane, *, api, timestamp):
    operation_lane = {**lane, "upload_step": "Upload immutable recovery baseline"}
    started, ended = receipts._upload_window(
        {"total_count": 1, "jobs": [job]},
        run,
        run["run_attempt"],
        operation_lane,
        timestamp,
    )
    inventory = api(repository, f"runs/{run['id']}/artifacts?per_page=100")
    rows = inventory.get("artifacts")
    _require(
        isinstance(rows, list)
        and inventory.get("total_count") == len(rows)
        and len(rows) <= 100
        and all(isinstance(row, dict) for row in rows),
        "operation artifact inventory is incomplete",
    )
    name = f"production-restoration-operation-{run['id']}-{run['run_attempt']}"
    matches = [row for row in rows if row.get("name") == name]
    _require(
        len(matches) == 1 and matches[0].get("expired") is False,
        "operation artifact is absent, expired or ambiguous",
    )
    created = receipts._artifact_created(matches[0], run, timestamp)
    _require(
        started - timedelta(seconds=5) <= created <= ended + timedelta(seconds=30),
        "operation artifact does not belong to this upload",
    )
    return matches[0]


def _plan(plan, record, digest, run):
    _require(
        plan
        == {
            "schemaVersion": 1,
            "runId": str(run["id"]),
            "workflowSha": run["head_sha"],
            "sourceSha": record["sourceSha"],
            "recordSha256": digest,
            "previous": record["previousServices"],
        }
        and type(plan.get("schemaVersion")) is int,
        "operation plan is not the canonical recorded baseline",
    )


def _validation(report, release):
    _require(
        report == release.get("production_restoration")
        and set(report)
        == {
            "status",
            "scope",
            "sourceSha",
            "workflowSha",
            "runId",
            "runAttempt",
            "artifactId",
            "artifactDigest",
        }
        and report.get("status") == "validated"
        and report.get("scope") == "production-restoration-only"
        and report.get("sourceSha") == release["sha"]
        and re.fullmatch(r"[0-9a-f]{40}", str(report.get("workflowSha", "")))
        and all(
            type(report.get(key)) is int and report[key] > 0
            for key in ("runId", "runAttempt", "artifactId")
        )
        and re.fullmatch(r"sha256:[0-9a-f]{64}", str(report.get("artifactDigest", ""))),
        "hosted restoration admission does not match the serving receipt",
    )


def _runtime(archive, release, record, run):
    qualified = phone._document(archive, "phone-rollback/qualified.json")
    previous = record["previousServices"]["consent-protocol"]
    _require(
        qualified
        == {
            "schema_version": 1,
            "qualification": "passed",
            "project": "hushh-pda",
            "region": "us-central1",
            "revision": previous["revision"],
            "source": previous["sha"],
            "image": previous["image"],
            "mode": "production-restoration",
            "run_id": str(run["id"]),
        }
        and type(qualified.get("schema_version")) is int,
        "qualified restoration baseline differs from the canonical operation",
    )
    summary = release.get("phone_rollback")
    _require(
        isinstance(summary, dict)
        and set(summary) == {"revision", "qualification", "recovery_enabled"}
        and summary
        == {
            "revision": previous["revision"],
            "qualification": "success",
            "recovery_enabled": "false",
        },
        "phone summary is not the qualified restoration baseline",
    )
    for lane, service in (
        ("backend", "consent-protocol"),
        ("frontend", "hushh-webapp"),
    ):
        candidate = release.get("candidate", {}).get(f"{lane}_revision")
        _require(
            isinstance(candidate, str)
            and re.fullmatch(rf"{service}-[a-z0-9-]+", candidate)
            and release.get("final", {}).get(f"{lane}_revision") == candidate,
            "serving pair is not the verified candidate",
        )
    _validation(phone._document(archive, "prod-restoration-validation.json"), release)


def serving_reference(
    repository, run, release, lane, *, api, governed, timestamp, run_command, timeout
):
    """Validate the original receipt unchanged; return no rollback/cleanup authority."""
    deadline = time.monotonic() + timeout
    original = {
        key: value
        for key, value in release.items()
        if not key.startswith("_maintenance_")
    }
    _origin(repository, run, original, lane, governed)
    record, digest = source_record(original.get("sha"))
    _require(
        original.get("sha") == record.get("sourceSha"), "restoration source changed"
    )
    artifact, job = receipts.current_attempt_artifact(
        repository, run, lane, api=api, timestamp=timestamp
    )
    archive = receipts.immutable_archive(
        repository,
        artifact,
        run_command=run_command,
        timeout=deadline - time.monotonic(),
    )
    _require(
        phone._document(archive, "prod-release-status.json") == original,
        "immutable release status differs from the selected serving receipt",
    )
    with ZipFile(BytesIO(archive)) as bundle:
        continuation = "prod-restoration-activation-origin.json" in bundle.namelist()
    _require(continuation == ("restoration_activation" in original),
             "continuation selector and immutable origin differ")
    if continuation:
        from production_restoration_continuation import serving_context

        return serving_context(
            run, original, job, archive, api=api, governed=governed,
            timestamp=timestamp, run_command=run_command,
            timeout=deadline - time.monotonic(),
        )
    _gates(job, run)
    operation = _operation(repository, run, job, lane, api=api, timestamp=timestamp)
    operation_archive = receipts.immutable_archive(
        repository,
        operation,
        run_command=run_command,
        timeout=deadline - time.monotonic(),
    )
    _plan(phone._document(operation_archive, "acceptance.json"), record, digest, run)
    _runtime(archive, original, record, run)
    current = api(repository, f"runs/{run['id']}")
    _require(
        all(
            current.get(key) == run.get(key)
            for key in (
                "id",
                "run_attempt",
                "head_sha",
                "status",
                "conclusion",
                "updated_at",
            )
        ),
        "restoration attempt changed during lookup",
    )
