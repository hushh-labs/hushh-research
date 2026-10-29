"""Fence deployment on unresolved cold health-route leases, never qualify readers."""

from __future__ import annotations

import os
import re
from runpy import run_path
import subprocess
import time

import production_phone_receipt as phone
import production_phone_lease_receipts as lease_documents
import production_phone_nonproducer as nonproducer
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
INTENT = "Publish initial cold health-tag intent"
BUILD_IF = "steps.scope.outputs.deploy_backend == 'true' && (env.PHONE_DEPLOY_PHASE != 'cold' || (steps.cold-lease.outcome == 'success' && steps.cold-lease-intent.outcome == 'success'))"
RESTORATION_JOB = nonproducer.JOB_ID
RESTORATION_ADMIT = nonproducer.ADMISSION_STEP


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


def _workflow_source(sha, source):
    raw = _source(["git", "show", f"{sha}:{WORKFLOW}"], source)
    _require(
        isinstance(raw, bytes) and 0 < len(raw) <= 1024 * 1024,
        "workflow source is unavailable",
    )
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise retention.UnsafeState(
            "Cold health lease reconciliation required: workflow source is invalid"
        ) from error


def _protocol(sha, newer, source):
    _source(["git", "merge-base", "--is-ancestor", sha, newer or "origin/main"], source)
    text = _workflow_source(sha, source)
    markers = (MARKER, BEGIN, CLEANUP, UPLOAD, "bootstrap.py")
    if not any(marker in text for marker in markers):
        # A later revert is not the historical policy boundary.
        history = _source(
            ["git", "log", "-S", MARKER, "--format=%H", sha, "--", WORKFLOW], source
        )
        _require(not history.strip(), "workflow is not a pre-protocol boundary")
        return False, text
    _require(
        all(marker in text for marker in markers),
        "workflow lease protocol is ambiguous",
    )
    if INTENT in text:
        _intent_gate(text)
        return "intent", text
    return True, text


def _intent_gate(text):
    blocks = re.findall(
        r"(?ms)^      - name: Deploy backend using Cloud Build\n(.*?)(?=^      - name:|\Z)",
        text,
    )
    conditions = (
        re.findall(r"^        if: (.+)$", blocks[0], re.M) if len(blocks) == 1 else []
    )
    _require(
        conditions == [BUILD_IF]
        and text.count(f"- name: {INTENT}") == 1
        and text.index(f"- name: {INTENT}") < text.index(f"- name: {DEPLOY}"),
        "immutable intent does not gate submission",
    )


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


def _attempt(repository, run, number, api, workflow):
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
    if not matches:
        try:
            skipped_name = nonproducer.skipped_primary_name(workflow)
        except ValueError as error:
            raise retention.UnsafeState(
                "Cold health lease reconciliation required: primary job source is ambiguous"
            ) from error
        matches = [
            job
            for job in jobs
            if skipped_name is not None and job.get("name") == skipped_name
        ]
        _require(
            len(matches) == 1
            and matches[0].get("status") == "completed"
            and matches[0].get("conclusion") == "skipped"
            and matches[0].get("steps") == [],
            "skipped primary job is not uniquely unexecuted",
        )
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


def _steps(job, current=False, source_gated=False, nonproducer=False):
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
        _require(guard or nonproducer, "attempt lease step is missing")
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
    intent, deploy = by_name.get(INTENT, {}), by_name.get(DEPLOY, {})
    if (
        source_gated
        and job.get("status") == "completed"
        and intent.get("status") == "completed"
        and intent.get("conclusion") == "failure"
        and deploy.get("status") == "completed"
        and deploy.get("conclusion") == "skipped"
        and deploy.get("started_at") is None
    ):
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


def _current(repository, attempt, job, trusted, restoration=False):
    jobs = {RESTORATION_JOB} if restoration else {"deploy", "complete-phone-activation"}
    return (
        trusted
        and os.environ.get("GITHUB_JOB") in jobs
        and attempt.get("status") == job.get("status") == "in_progress"
        and all(
            os.environ.get(key) == value
            for key, value in {
                "GITHUB_RUN_ID": str(attempt["id"]),
                "GITHUB_RUN_ATTEMPT": str(attempt["run_attempt"]),
                "GITHUB_REPOSITORY": repository,
                "GITHUB_REF_NAME": "main",
                **({"GITHUB_SHA": attempt["head_sha"]} if restoration else {}),
            }.items()
        )
    )


def _restoration_nonproducer(repository, attempt, job, trusted, text, source):
    if not nonproducer.recognizes(job):
        return False
    _require(trusted, "restoration nonproducer is not governed")
    reference = os.environ.get("GITHUB_SHA") or "origin/main"
    _require(
        reference == "origin/main" or re.fullmatch(r"[0-9a-f]{40}", reference),
        "trusted workflow reference is invalid",
    )
    try:
        nonproducer.qualify(
            job,
            attempt,
            text,
            _workflow_source(reference, source),
            current=_current(repository, attempt, job, trusted, restoration=True),
            lease_markers=(
                BEGIN,
                INTENT,
                DEPLOY,
                CLEANUP,
                UPLOAD,
                MARKER,
                "bootstrap.py",
            ),
            guard=GUARD,
        )
    except ValueError as error:
        raise retention.UnsafeState(
            "Cold health lease reconciliation required: restoration nonproducer proof refused"
        ) from error
    return True


def _artifact(repository, attempt, result, api, timestamp):
    return lease_documents.artifact(
        repository,
        attempt,
        result,
        api,
        timestamp,
        job=JOB,
        upload=UPLOAD,
        name=f"{MARKER}{attempt['id']}-{attempt['run_attempt']}",
    )


_retired = lease_documents.validate
_traffic = lease_documents.traffic


def _verify_retired(
    repository, attempt, result, job, protocol, *, api, timestamp, deadline, run_command
):
    original = None
    if protocol == "intent":
        original = lease_documents.intent(
            repository,
            attempt,
            result,
            {step["name"]: step for step in job["steps"]},
            job=JOB,
            begin=BEGIN,
            upload=INTENT,
            deploy=DEPLOY,
            api=api,
            timestamp=timestamp,
            run_command=run_command or retention.run_command,
            timeout=_budget(deadline),
        )
    artifact = _artifact(repository, attempt, result, api, timestamp)
    archive = receipts.immutable_archive(
        repository,
        artifact,
        run_command=run_command or retention.run_command,
        timeout=_budget(deadline),
    )
    final = phone._document(archive, "initial-lease.json")
    _retired(final, attempt)
    if original is not None:
        lease_documents.bind_final(final, original)


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
        protocol, text = _protocol(run["head_sha"], newer, source_command)
        newer = run["head_sha"]
        governed_view = {**run, "status": "completed"}
        trusted = governed(governed_view, repository, "production")
        if not protocol:
            if trusted and run.get("status") == "completed":
                return
            continue
        for number in range(run["run_attempt"], 0, -1):
            attempt, result, job = _attempt(repository, run, number, api, text)
            if (
                job is None
                or _steps(
                    job,
                    _current(repository, attempt, job, trusted),
                    protocol == "intent",
                    _restoration_nonproducer(
                        repository, attempt, job, trusted, text, source_command
                    ),
                )
                is None
            ):
                continue
            _require(
                trusted
                and governed(
                    {**attempt, "status": "completed"}, repository, "production"
                ),
                "lease producer is not governed",
            )
            _verify_retired(
                repository,
                attempt,
                result,
                job,
                protocol,
                api=api,
                timestamp=timestamp,
                deadline=deadline,
                run_command=run_command,
            )
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
