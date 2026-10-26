"""Fence deployment on unresolved cold health-route leases, never qualify readers."""

from __future__ import annotations

import json
import os
import re
from runpy import run_path
import subprocess
import time

import production_phone_receipt as phone
import release_artifact_receipts as receipts

retention = receipts.retention
WORKFLOW = ".github/workflows/deploy-production.yml"
JOB = "Deploy Production Scope"
BEGIN = "Record initial cold health-tag lease"
DEPLOY = "Deploy backend using Cloud Build"
CLEANUP = "Retire initial cold health-tag lease"
UPLOAD = "Publish cold health-tag reconciliation evidence"
MARKER = "prod-phone-health-lease-"
GUARD = "Require reconciled maintenance mutations under deployment lock"


def _require(condition, reason):
    if not condition:
        raise retention.UnsafeState(
            f"Cold health lease reconciliation required: {reason}"
        )


def _budget(deadline):
    remaining = retention.remaining_seconds(90)
    if deadline is not None:
        remaining = min(remaining, deadline - time.monotonic())
    _require(remaining > 0, "authority lookup deadline exhausted")
    return remaining


def _history(repository, api, timestamp):
    previous, seen, total = None, set(), None
    for page in range(1, 11):
        result = api(
            repository,
            f"workflows/deploy-production.yml/runs?branch=main&per_page=100&page={page}",
        )
        rows, count = result.get("workflow_runs"), result.get("total_count")
        _require(
            isinstance(rows, list)
            and len(rows) <= 100
            and type(count) is int
            and count >= 0,
            "run inventory is invalid",
        )
        _require(total is None or total == count, "run inventory changed during lookup")
        total = count
        _require(
            len(rows) == min(100, max(total - len(seen), 0)),
            "run inventory is truncated",
        )
        for row in rows:
            _require(
                isinstance(row, dict) and type(row.get("id")) is int and row["id"] > 0,
                "run identity is invalid",
            )
            created = timestamp(row.get("created_at"))
            _require(
                created is not None
                and row["id"] not in seen
                and (
                    previous is None
                    or row["id"] < previous[0]
                    and created <= previous[1]
                ),
                "run chronology is uncertain",
            )
            previous = row["id"], created
            seen.add(row["id"])
            yield row
        if len(rows) < 100:
            _require(len(seen) == total, "run inventory is truncated")
            return
    raise retention.UnsafeState(
        "Cold health lease reconciliation required: history exceeds bounded inventory"
    )


def _run(repository, listed, api):
    run = api(repository, f"runs/{listed['id']}")
    _require(
        isinstance(run, dict)
        and all(
            run.get(key) == listed.get(key)
            for key in ("id", "head_sha", "run_attempt", "created_at")
        ),
        "run changed during lookup",
    )
    _require(
        run.get("path") == WORKFLOW
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and (run.get("repository") or {}).get("full_name") == repository
        and (run.get("head_repository") or {}).get("full_name") == repository
        and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        and type(run.get("run_attempt")) is int
        and 1 <= run["run_attempt"] <= 10,
        "run origin or attempt inventory is invalid",
    )
    return run


def _protocol(sha, newer, source):
    _source(["git", "merge-base", "--is-ancestor", sha, newer or "origin/main"], source)
    raw = _source(["git", "show", f"{sha}:{WORKFLOW}"], source)
    _require(
        isinstance(raw, bytes) and 0 < len(raw) <= 1024 * 1024,
        "workflow source is unavailable",
    )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise retention.UnsafeState(
            "Cold health lease reconciliation required: workflow source is invalid"
        ) from error
    markers = (MARKER, BEGIN, CLEANUP, UPLOAD, "bootstrap.py")
    if not any(marker in text for marker in markers):
        # A later revert is not the historical policy boundary.
        history = _source(
            ["git", "log", "-S", MARKER, "--format=%H", sha, "--", WORKFLOW], source
        )
        _require(not history.strip(), "workflow is not a pre-protocol boundary")
        return False
    _require(
        all(marker in text for marker in markers),
        "workflow lease protocol is ambiguous",
    )
    return True


def _source(args, port):
    try:
        return port(args)
    except (
        OSError,
        ValueError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as error:
        raise retention.UnsafeState(
            "Cold health lease reconciliation required: workflow source or ancestry is unavailable"
        ) from error


def _attempt(repository, run, number, api):
    attempt = api(repository, f"runs/{run['id']}/attempts/{number}")
    _require(
        isinstance(attempt, dict)
        and all(
            attempt.get(key) == run.get(key)
            for key in (
                "id",
                "head_sha",
                "head_branch",
                "path",
                "event",
                "repository",
                "head_repository",
            )
        )
        and attempt.get("run_attempt") == number,
        "attempt origin is invalid",
    )
    result = api(repository, f"runs/{run['id']}/attempts/{number}/jobs?per_page=100")
    jobs = result.get("jobs")
    _require(
        isinstance(jobs, list)
        and len(jobs) <= 100
        and result.get("total_count") == len(jobs)
        and all(isinstance(job, dict) for job in jobs),
        "attempt job inventory is incomplete",
    )
    matches = [job for job in jobs if job.get("name") == JOB]
    if not matches and attempt.get("status") in {
        "queued",
        "waiting",
        "requested",
        "pending",
    }:
        return attempt, result, None
    _require(
        len(matches) == 1
        and all(
            matches[0].get(key) == value
            for key, value in {
                "run_id": run["id"],
                "run_attempt": number,
                "head_sha": run["head_sha"],
                "head_branch": "main",
            }.items()
        ),
        "attempt job is not bound",
    )
    return attempt, result, matches[0]


def _steps(job, current=False):
    steps = job.get("steps")
    _require(
        isinstance(steps, list)
        and len(steps) <= 500
        and all(
            isinstance(step, dict) and isinstance(step.get("name"), str)
            for step in steps
        ),
        "attempt steps are invalid",
    )
    if (
        job.get("status") == "completed"
        and job.get("conclusion") == "skipped"
        and not steps
    ):
        return None
    by_name = {step["name"]: step for step in steps}
    _require(len(by_name) == len(steps), "attempt lease step is ambiguous")
    guard = (
        current
        and by_name.get(GUARD, {}).get("status") == "in_progress"
        and by_name[GUARD].get("conclusion") is None
        and sum(step.get("status") == "in_progress" for step in steps) == 1
    )
    if BEGIN not in by_name:
        _require(guard, "attempt lease step is missing")
        return None
    begin = by_name[BEGIN]
    if begin.get("conclusion") == "skipped":
        return None
    if (
        begin.get("status") in {"queued", "pending"}
        and begin.get("started_at") is None
        and job.get("status") != "completed"
    ):
        _require(guard, "an earlier producer is still active")
        return None
    _require(
        job.get("status") == "completed"
        and all(
            by_name.get(name, {}).get("status") == "completed"
            and by_name[name].get("conclusion") == "success"
            for name in (BEGIN, DEPLOY, CLEANUP, UPLOAD)
        ),
        "lease work or publication is failed, missing or active",
    )
    return by_name


def _current(repository, attempt, job, trusted):
    return (
        trusted
        and attempt.get("status") == job.get("status") == "in_progress"
        and all(
            os.environ.get(key) == value
            for key, value in {
                "GITHUB_RUN_ID": str(attempt["id"]),
                "GITHUB_RUN_ATTEMPT": str(attempt["run_attempt"]),
                "GITHUB_JOB": "deploy",
                "GITHUB_REPOSITORY": repository,
                "GITHUB_REF_NAME": "main",
            }.items()
        )
    )


def _artifact(repository, attempt, result, api, timestamp):
    lane = {"deploy_job": JOB, "upload_step": UPLOAD}
    started, ended = receipts._upload_window(
        result, attempt, attempt["run_attempt"], lane, timestamp
    )
    inventory = api(repository, f"runs/{attempt['id']}/artifacts?per_page=100")
    rows = inventory.get("artifacts")
    _require(
        isinstance(rows, list)
        and len(rows) <= 100
        and inventory.get("total_count") == len(rows)
        and all(isinstance(row, dict) for row in rows),
        "lease artifact inventory is incomplete",
    )
    name = f"{MARKER}{attempt['id']}-{attempt['run_attempt']}"
    matches = [row for row in rows if row.get("name") == name]
    _require(
        len(matches) == 1 and matches[0].get("expired") is False,
        "lease artifact is missing, expired or ambiguous",
    )
    created = receipts._artifact_created(matches[0], attempt, timestamp)
    _require(
        started.timestamp() - 5 <= created.timestamp() <= ended.timestamp() + 30,
        "lease publication is not attempt-bound",
    )
    return matches[0]


def _retired(lease, attempt):
    origin = {"run_id": str(attempt["id"]), "run_attempt": attempt["run_attempt"]}
    _require(
        type(lease.get("schema_version")) is int
        and lease["schema_version"] == 1
        and lease.get("kind") == "phone-cold-health-lease"
        and lease.get("project") == "hushh-pda"
        and lease.get("region") == "us-central1"
        and lease.get("service") == "consent-protocol"
        and lease.get("origin") == origin
        and type(lease["origin"].get("run_attempt")) is int
        and lease.get("workflow_sha") == attempt["head_sha"]
        and lease.get("tag") == f"phone-rollback-{attempt['id']}"
        and re.fullmatch(r"[0-9a-f]{40}", str(lease.get("source", "")))
        and re.fullmatch(
            r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}",
            str(lease.get("image", "")),
        )
        and lease.get("status") == "retired"
        and "pending_mutation" in lease
        and lease["pending_mutation"] is None
        and isinstance(lease.get("service_uid"), str)
        and 0 < len(lease["service_uid"]) <= 256
        and all(
            re.fullmatch(r"[0-9a-f]{64}", str(lease.get(key, "")))
            for key in ("controls", "iam")
        )
        and _traffic(lease)
        and "revision" in lease
        and (
            lease["revision"] is None
            or re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(lease["revision"]))
        ),
        "lease retirement is invalid or unresolved",
    )


def _traffic(lease):
    serving, traffic = lease.get("serving"), lease.get("traffic")
    if not (
        isinstance(serving, list)
        and len(serving) == 1
        and isinstance(serving[0], list)
        and len(serving[0]) == 2
        and re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(serving[0][0]))
        and type(serving[0][1]) is int
        and serving[0][1] == 100
        and isinstance(traffic, list)
        and len(traffic) == 2
        and isinstance(traffic[0], list)
        and len(traffic[0]) <= 100
        and isinstance(traffic[1], str)
        and len(traffic[1]) <= 65536
    ):
        return False
    try:
        desired = json.loads(traffic[1], object_pairs_hook=phone._unique_object)
    except (TypeError, ValueError):
        return False
    return (
        isinstance(desired, list)
        and len(desired) <= 100
        and all(
            isinstance(row, dict) and row.get("tag") != lease["tag"] for row in desired
        )
        and all(
            isinstance(row, list)
            and len(row) == 3
            and re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(row[0]))
            and type(row[1]) is int
            and 0 <= row[1] <= 100
            and isinstance(row[2], str)
            and len(row[2]) <= 63
            and row[2] != lease["tag"]
            for row in traffic[0]
        )
        and sorted([row[0], row[1]] for row in traffic[0] if row[1]) == serving
    )


def assert_reconciled(
    repository,
    *,
    api,
    governed,
    timestamp,
    deadline=None,
    source_command=None,
    run_command=None,
):
    """Walk every attempt to a proven pre-policy boundary; admit no mutation."""
    if source_command is None:
        command = run_path(str(phone.ROOT / "deploy/phone/qualify_image.py"))["run"]

        def source_command(args):
            return command(args, timeout=_budget(deadline))

    newer = None
    for listed in _history(repository, api, timestamp):
        run = _run(repository, listed, api)
        protocol = _protocol(run["head_sha"], newer, source_command)
        newer = run["head_sha"]
        governed_view = {**run, "status": "completed"}
        trusted = governed(governed_view, repository, "production")
        if not protocol:
            if trusted and run.get("status") == "completed":
                return
            continue
        for number in range(run["run_attempt"], 0, -1):
            attempt, result, job = _attempt(repository, run, number, api)
            if (
                job is None
                or _steps(job, _current(repository, attempt, job, trusted)) is None
            ):
                continue
            _require(
                trusted
                and governed(
                    {**attempt, "status": "completed"}, repository, "production"
                ),
                "lease producer is not governed",
            )
            artifact = _artifact(repository, attempt, result, api, timestamp)
            archive = receipts.immutable_archive(
                repository,
                artifact,
                run_command=run_command or retention.run_command,
                timeout=_budget(deadline),
            )
            _retired(phone._document(archive, "initial-lease.json"), attempt)
        refreshed = api(repository, f"runs/{run['id']}?exclude_pull_requests=true")
        _require(
            all(
                refreshed.get(key) == run.get(key)
                for key in ("id", "head_sha", "run_attempt", "status", "conclusion")
            ),
            "producer attempt changed during lookup",
        )
    raise retention.UnsafeState(
        "Cold health lease reconciliation required: no verified pre-protocol boundary"
    )
