# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Recover only an immutable pre-DDL schema intent from its governed attempt."""

from __future__ import annotations

import json
import re
import tempfile
from datetime import timedelta
from pathlib import Path

from bootstrap_ports import REPOSITORY, WORKFLOW, _api, _authorities

UPLOAD = "Publish initial cold schema intent"
PREFIX = "prod-phone-schema-intent"


def _builds(start: str) -> list[dict]:
    import workos_rollout as closed

    command = [
        "gcloud",
        "builds",
        "list",
        "--project=hushh-pda",
        "--region=global",
        f"--filter=createTime>={start} OR status=PENDING OR status=STATUS_UNKNOWN OR status=QUEUED OR status=WORKING",
        f"--limit={closed.LIMIT}",
        "--format=json",
    ]
    rows = closed._document(command)
    if not isinstance(rows, list) or len(rows) >= closed.LIMIT:
        raise ValueError("phone_schema_build_inventory_incomplete")
    result, seen = [], set()
    for row in rows:
        identity = row.get("id")
        if (
            not isinstance(identity, str)
            or not re.fullmatch(r"[0-9a-f-]{36}", identity)
            or identity in seen
        ):
            raise ValueError("phone_schema_build_identity_unknown")
        seen.add(identity)
        detail = closed._document(
            [
                "gcloud",
                "builds",
                "describe",
                identity,
                "--project=hushh-pda",
                "--region=global",
                "--format=json",
            ]
        )
        if any(
            detail.get(key) != row.get(key) for key in ("id", "status", "createTime")
        ):
            raise ValueError("phone_schema_build_inventory_changed")
        if detail.get("status") not in {
            "SUCCESS",
            "FAILURE",
            "CANCELLED",
            "TIMEOUT",
            "EXPIRED",
            "INTERNAL_ERROR",
        }:
            raise ValueError("phone_schema_build_producer_unfinished")
        if any(step.get("id") == "deploy-backend" for step in detail.get("steps", [])):
            if detail.get("status") != "SUCCESS":
                raise ValueError("phone_schema_build_producer_unacknowledged")
            result.append(detail)
    if closed._document(command) != rows:
        raise ValueError("phone_schema_build_inventory_changed")
    return result


def _job_steps(job: dict) -> list[dict]:
    steps = job.get("steps")
    if (
        not isinstance(steps, list)
        or len(steps) > 500
        or any(
            not isinstance(step, dict) or not isinstance(step.get("name"), str)
            for step in steps
        )
        or len({step["name"] for step in steps}) != len(steps)
    ):
        raise ValueError("phone_schema_prior_submission_inventory_unknown")
    return steps


def _acknowledged(
    attempt: dict, job: dict, builds: list, owner: dict, timestamp
) -> dict | None:
    current = (
        str(attempt["id"]) == owner["run_id"]
        and attempt["run_attempt"] == owner["run_attempt"]
    )
    if current and attempt.get("status") != "in_progress":
        raise ValueError("phone_schema_current_submission_phase_unknown")
    steps = _job_steps(job)
    matches = [
        step for step in steps if step.get("name") == "Deploy backend using Cloud Build"
    ]
    if (
        job.get("status") == "completed"
        and job.get("conclusion") == "skipped"
        and steps == []
    ):
        return None
    if len(matches) > 1:
        raise ValueError("phone_schema_prior_submission_unknown")
    if (
        current
        and job.get("status") == "in_progress"
        and (not matches or matches[0].get("status") in {"queued", "pending"})
    ):
        active = [
            step.get("name") for step in steps if step.get("status") == "in_progress"
        ]
        if active not in [
            ["Qualify initial cold schema boundary"],
            ["Qualify installed cold schema"],
        ]:
            raise ValueError("phone_schema_current_submission_phase_unknown")
        return None
    if len(matches) != 1:
        raise ValueError("phone_schema_prior_submission_unknown")
    if not current and (
        attempt.get("status") != "completed" or job.get("status") != "completed"
    ):
        raise ValueError("phone_schema_prior_producer_unfinished")
    step = matches[0]
    if step.get("conclusion") == "skipped" and step.get("started_at") is None:
        return None
    if step.get("status") != "completed" or step.get("conclusion") != "success":
        raise ValueError("phone_schema_prior_submission_unacknowledged")
    if current and [
        step.get("name") for step in steps if step.get("status") == "in_progress"
    ] != ["Qualify final cold installed-schema proof"]:
        raise ValueError("phone_schema_current_submission_phase_unknown")
    started, ended = (
        timestamp(step.get("started_at")),
        timestamp(step.get("completed_at")),
    )
    matching = [
        build
        for build in builds
        if (
            build.get("substitutions", {}).get("_GITHUB_RUN_ID") == str(attempt["id"])
            and started is not None
            and ended is not None
            and started
            <= timestamp(build.get("createTime"))
            <= timestamp(build.get("finishTime"))
            <= ended
        )
    ]
    if len(matching) != 1:
        raise ValueError("phone_schema_prior_submission_build_ambiguous")
    (build,) = matching
    return _build_binding(build, attempt, timestamp)


def _build_binding(build: dict, attempt: dict, timestamp) -> dict:
    settings = build["substitutions"]
    if (
        build.get("status") != "SUCCESS"
        or settings.get("_DEPLOY_ENV") != "production"
        or settings.get("_BACKEND_SERVICE") != "consent-protocol"
        or not re.fullmatch(r"[0-9a-f]{40}", str(settings.get("_DEPLOY_SHA", "")))
        or settings.get("_GITHUB_RUN_ATTEMPT", "unknown")
        not in {"unknown", str(attempt["run_attempt"])}
        or not timestamp(build.get("finishTime"))
    ):
        raise ValueError("phone_schema_prior_submission_binding_unknown")
    phase = settings.get("_PHONE_DEPLOY_PHASE", "standard")
    if phase not in {"standard", "cold"} or (
        settings.get("_GITHUB_RUN_ATTEMPT", "unknown") != "unknown"
        and f"phone-{phase}-{attempt['id']}-{attempt['run_attempt']}"
        not in build.get("tags", [])
    ):
        raise ValueError("phone_schema_prior_submission_phase_unknown")
    source = (
        settings.get("_PHONE_ROLLBACK_SHA")
        if phase == "cold"
        else settings["_DEPLOY_SHA"]
    )
    image = (
        settings.get("_PHONE_ROLLBACK_IMAGE_REFERENCE")
        if phase == "cold"
        else settings.get("_IMAGE_REFERENCE")
    )
    if not re.fullmatch(r"[0-9a-f]{40}", str(source)) or not re.fullmatch(
        r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", str(image)
    ):
        raise ValueError("phone_schema_prior_submission_image_unknown")
    return {
        "run_id": str(attempt["id"]),
        "run_attempt": attempt["run_attempt"],
        "build_id": build["id"],
        "source": source,
        "image": image,
    }


def closed_submissions(owner: dict, *, start: str, source_anchor: str) -> dict:
    """Join observed terminal builds to acknowledged canonical synchronous attempts."""
    authority = _authorities()
    import production_phone_lease as history
    from qualify_image import run

    timestamp = authority._github_timestamp

    def api(_repository, endpoint):
        return _api(endpoint)

    builds, accepted, boundary = _builds(start), [], False
    for listed in history._history(REPOSITORY, api, timestamp):
        producer = history._run(REPOSITORY, listed, api)
        if not authority.governed_dispatch(
            {**producer, "status": "completed"}, REPOSITORY, "production"
        ):
            raise ValueError("phone_schema_prior_producer_ungoverned")
        if (
            timestamp(producer["created_at"]) < timestamp(start)
            and producer.get("status") == "completed"
            and timestamp(producer.get("updated_at")) is not None
            and timestamp(producer["updated_at"]) < timestamp(start)
        ):
            run(
                [
                    "git",
                    "merge-base",
                    "--is-ancestor",
                    producer["head_sha"],
                    source_anchor + "^",
                ]
            )
            boundary = True
            break
        source = run(["git", "show", f"{producer['head_sha']}:{WORKFLOW}"]).decode()
        blocks = re.findall(
            r"(?ms)^      - name: Deploy backend using Cloud Build\n(.*?)(?=^      - name:|\Z)",
            source,
        )
        if (
            len(blocks) != 1
            or "set -euo pipefail" not in blocks[0]
            or "--async" in blocks[0]
            or blocks[0].count("gcloud builds submit") != 1
        ):
            raise ValueError("phone_schema_prior_submit_source_unknown")
        for number in range(producer["run_attempt"], 0, -1):
            attempt, _result, job = history._attempt(REPOSITORY, producer, number, api)
            if job is None:
                # The shared reader permits this only for a queued workflow
                # with no admitted deploy job; it cannot yet submit a build.
                continue
            receipt = _acknowledged(attempt, job, builds, owner, timestamp)
            if receipt:
                accepted.append(receipt)
    if not boundary or {row["build_id"] for row in accepted} != {
        row["id"] for row in builds
    }:
        raise ValueError("phone_schema_prior_producer_history_incomplete")
    return {
        "qualification": "passed",
        "history_start": start,
        "source_anchor": source_anchor,
        "acknowledged_attempts": accepted,
    }


def load(run_id: str, attempt_number: int) -> tuple[dict, dict]:
    if not re.fullmatch(r"[1-9][0-9]*", run_id) or attempt_number < 1:
        raise ValueError("phone_schema_origin_invalid")
    authority = _authorities()
    attempt = _api(f"runs/{run_id}/attempts/{attempt_number}")
    if (
        attempt.get("id") != int(run_id)
        or attempt.get("run_attempt") != attempt_number
        or attempt.get("status") != "completed"
        or attempt.get("path") != WORKFLOW
        or not authority.governed_dispatch(attempt, REPOSITORY, "production")
    ):
        raise ValueError("phone_schema_origin_unqualified")
    jobs = _api(f"runs/{run_id}/attempts/{attempt_number}/jobs?per_page=100")
    rows = jobs.get("jobs", [])
    matching = [job for job in rows if job.get("name") == "Deploy Production Scope"]
    if jobs.get("total_count") != len(rows) or len(matching) != 1:
        raise ValueError("phone_schema_origin_job_unqualified")
    steps = {step.get("name"): step for step in matching[0].get("steps", [])}
    if steps.get("Deploy backend using Cloud Build", {}).get("conclusion") != "skipped":
        raise ValueError("phone_schema_origin_runtime_requires_reconciliation")
    receipts = authority.release_artifact_receipts
    started, ended = receipts._upload_window(
        jobs,
        attempt,
        attempt_number,
        {"deploy_job": "Deploy Production Scope", "upload_step": UPLOAD},
        authority._github_timestamp,
    )
    inventory = _api(f"runs/{run_id}/artifacts?per_page=100")
    artifacts = inventory.get("artifacts", [])
    selected = [
        row
        for row in artifacts
        if row.get("name") == f"{PREFIX}-{run_id}-{attempt_number}"
    ]
    if (
        inventory.get("total_count") != len(artifacts)
        or len(selected) != 1
        or selected[0].get("expired") is not False
    ):
        raise ValueError("phone_schema_origin_artifact_unqualified")
    artifact = selected[0]
    created = receipts._artifact_created(artifact, attempt, authority._github_timestamp)
    if not started - timedelta(seconds=5) <= created <= ended + timedelta(seconds=30):
        raise ValueError("phone_schema_origin_upload_changed")
    with tempfile.TemporaryDirectory(prefix="phone-schema-origin-") as temporary:
        folder = Path(temporary)
        receipts.download_replayed_artifact(
            REPOSITORY,
            artifact,
            folder,
            "schema-preflight.json",
            run_command=authority.retention.run_command,
            timeout=90,
        )
        proof = json.loads((folder / "schema-preflight.json").read_text())
    expected = {
        "run_id": run_id,
        "run_attempt": attempt_number,
        "workflow_sha": attempt["head_sha"],
        "workflow": WORKFLOW,
    }
    if (
        proof.get("origin") != expected
        or _api(f"runs/{run_id}/attempts/{attempt_number}") != attempt
    ):
        raise ValueError("phone_schema_origin_identity_changed")
    return proof, {
        "origin": expected,
        "artifact_id": artifact["id"],
        "artifact_digest": artifact["digest"],
    }
