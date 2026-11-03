"""Exact clock-bound production guard evidence and its bounded API witness."""

from __future__ import annotations

import json
import re

import retention_preflight_evidence as base
import retention_production_evidence as production
from retention_production_clock_records import (
    CLOCK_BOUND_RECORDS,
    CLOCK_BOUND_SOURCE_PROFILES,
    ClockBoundRecord,
)

ENVIRONMENT = production.ENVIRONMENT
JOB = production.JOB
STEP_NAMES = production.STEP_NAMES
CLOCK_BOUND_STEP_NAMES = tuple(
    name
    for name in STEP_NAMES
    if name != "Post Prepare operational database verification runtime"
)
PUBLICATION = production.PUBLICATION
SOURCE_PATHS = production.SOURCE_PATHS

CLOCK_WORKFLOW = ".github/workflows/capacity-maintenance-clock.yml"
HISTORICAL_NUMBERED_CLOCK_WORKFLOW_BLOB = (
    "8f81156d0b980c19da5bbaf3187eb071e58b8af1",
    9365,
)
CURRENT_CLOCK_TITLE = "Capacity clock"
CURRENT_CLOCK_WORKFLOW_BLOB = ("0e905f3da506f5573a0c4282b8e60232be13336d", 9305)
# Existing immutable receipts remain pinned to the run-numbered title/blob
# pair; new dynamic qualification uses the exact current title/blob pair above.
_HISTORICAL_NUMBERED_CLOCK_TITLE = re.compile(
    r"Capacity clock · (?:repository_dispatch|schedule) · run [1-9][0-9]*\Z"
)
MAX_WAKE_TO_WORKER_SECONDS = 2


def _clock_workflow_blob_for_title(title):
    if title == CURRENT_CLOCK_TITLE:
        return CURRENT_CLOCK_WORKFLOW_BLOB
    if isinstance(title, str) and _HISTORICAL_NUMBERED_CLOCK_TITLE.fullmatch(title):
        return HISTORICAL_NUMBERED_CLOCK_WORKFLOW_BLOB
    return None


def settled_production_failure(run, job):
    """An independent queued UAT job cannot reopen a settled production job."""
    workflow_state = (
        (run.get("status") == "completed" and run.get("conclusion") == "failure")
        or (run.get("status") in {"pending", "queued", "waiting", "in_progress"}
            and run.get("conclusion") is None)
    )
    return workflow_state and job.get("status") == "completed" and job.get("conclusion") == "failure"


def _strict_int_equals(value, expected):
    return type(value) is int and type(expected) is int and value == expected


def _record_source_matches(record, source_blobs, workflow_blob):
    profile = CLOCK_BOUND_SOURCE_PROFILES.get(record.source_profile)
    if profile is None:
        return False
    expected = {
        path: {"sha": sha, "size": size} for path, (sha, size) in profile.items()
    }
    return source_blobs == expected and workflow_blob == expected[base.WORKFLOW]


def _named_steps(job):
    rows = job.get("steps") if isinstance(job, dict) else None
    if not isinstance(rows, list) or not all(
        isinstance(step, dict) and isinstance(step.get("name"), str) for step in rows
    ):
        return None
    indexed = {step["name"]: step for step in rows}
    return indexed if len(indexed) == len(rows) else None


def _clock_job_matches(job, record, job_id, name, required_steps):
    if not isinstance(job, dict) or not (
        _strict_int_equals(job.get("id"), job_id)
        and _strict_int_equals(job.get("run_id"), record.clock.run_id)
        and _strict_int_equals(job.get("run_attempt"), 1)
        and job.get("head_sha") == record.clock.head_sha
        and job.get("head_branch") == "main"
        and job.get("name") == name
        and job.get("status") == "completed"
        and job.get("conclusion") == "success"
    ):
        return False
    steps = _named_steps(job)
    return steps is not None and all(
        steps.get(step, {}).get("status") == "completed"
        and steps.get(step, {}).get("conclusion") == "success"
        for step in required_steps
    )


def _login(run, key):
    actor = run.get(key) if isinstance(run, dict) else None
    return actor.get("login") if isinstance(actor, dict) else None


def _clock_proof_matches(record, worker_run, clock_proof):
    if not isinstance(clock_proof, dict):
        return False
    clock = clock_proof.get("run")
    check = clock_proof.get("check_job")
    wake = clock_proof.get("wake_job")
    check_steps = _named_steps(check)
    wake_steps = _named_steps(wake)
    clock_record = record.clock
    if not isinstance(clock, dict) or check_steps is None or wake_steps is None:
        return False
    expected_clock_blob = _clock_workflow_blob_for_title(clock_record.title)
    if expected_clock_blob is None:
        return False
    if not (
        _strict_int_equals(clock.get("id"), clock_record.run_id)
        and _strict_int_equals(clock.get("run_attempt"), 1)
        and clock.get("event") == clock_record.event
        and clock.get("display_title") == clock_record.title
        and clock.get("path") == CLOCK_WORKFLOW
        and clock.get("head_branch") == "main"
        and clock.get("head_sha") == clock_record.head_sha
        and clock.get("created_at") == clock_record.created_at
        and _login(clock, "actor") == clock_record.actor
        and _login(clock, "triggering_actor") == clock_record.actor
        and _login(clock, "actor") == _login(clock, "triggering_actor")
        and production._full_name(clock, "repository") == base.REPOSITORY
        and production._full_name(clock, "head_repository") == base.REPOSITORY
        and (
            clock.get("status") in ("queued", "waiting", "in_progress")
            and clock.get("conclusion") is None
            or clock.get("status") == "completed"
            and clock.get("conclusion") == "success"
        )
        and clock_proof.get("workflow_blob")
        == {"sha": expected_clock_blob[0], "size": expected_clock_blob[1]}
        and _clock_job_matches(
            check,
            record,
            clock_record.check_job_id,
            "Check for due maintenance without cloud credentials",
            ("Check uat", "Check production"),
        )
        and check.get("completed_at") == clock_record.check_completed_at
        and _clock_job_matches(
            wake,
            record,
            clock_record.wake_job_id,
            "Wake Capacity Maintenance for due work",
            ("Send one capacity-maintenance-tick",),
        )
        and wake.get("completed_at") == clock_record.wake_completed_at
        and wake_steps["Send one capacity-maintenance-tick"].get("completed_at")
        == clock_record.tick_completed_at
    ):
        return False
    return _dispatch_timing_matches(record, worker_run, check, wake)


def _dispatch_timing_matches(record, worker_run, check, wake):
    clock_record = record.clock
    checked_at = base._stamp(check.get("completed_at"))
    wake_started = base._stamp(wake.get("started_at"))
    wake_completed = base._stamp(wake.get("completed_at"))
    worker_created = base._stamp(worker_run.get("created_at"))
    wake_steps = _named_steps(wake) or {}
    dispatch = wake_steps.get("Send one capacity-maintenance-tick", {})
    dispatch_started = base._stamp(dispatch.get("started_at"))
    dispatch_completed = base._stamp(dispatch.get("completed_at"))
    return bool(
        checked_at
        and wake_started
        and wake_completed
        and worker_created
        and checked_at <= wake_started <= wake_completed
        and (
            wake_completed <= worker_created
            and (worker_created - wake_completed).total_seconds()
            <= MAX_WAKE_TO_WORKER_SECONDS
            or (
                # The child run can start before GitHub finishes post-job
                # cleanup. Bind it to the successful dispatch step itself,
                # never add grace to the enclosing job's elapsed time.
                dispatch.get("status") == "completed"
                and dispatch.get("conclusion") == "success"
                and dispatch_started is not None
                and dispatch_completed is not None
                and wake_started <= dispatch_started <= dispatch_completed
                <= worker_created < wake_completed
                and dispatch_completed == base._stamp(clock_record.tick_completed_at)
                and (worker_created - dispatch_completed).total_seconds()
                <= MAX_WAKE_TO_WORKER_SECONDS
            )
            or (
                # One recorded dispatch completed before its enclosing job.
                # Exact IDs/timestamps above remain mandatory; no generic grace.
                record.wake_overlap_seconds == 4
                and record.clock.run_id == 41469323819
                and base._stamp(clock_record.tick_completed_at) is not None
                and wake_started
                <= base._stamp(clock_record.tick_completed_at)
                <= worker_created
                < wake_completed
                and (wake_completed - worker_created).total_seconds() == 4
                and (
                    worker_created - base._stamp(clock_record.tick_completed_at)
                ).total_seconds()
                == 3
            )
        )
    )


def _clock_bound_run_matches(
    repository, run, job, source_blobs, workflow_blob, clock_proof, *, record=None
):
    if not isinstance(run, dict) or not isinstance(job, dict):
        return False
    if type(run.get("id")) is not int:
        return False
    record = record or CLOCK_BOUND_RECORDS.get(run.get("id"))
    if record is None:
        return False
    return bool(
        repository == base.REPOSITORY
        and _strict_int_equals(run.get("run_attempt"), 1)
        and settled_production_failure(run, job)
        and run.get("path") == base.WORKFLOW
        and run.get("head_branch") == "main"
        and run.get("event") == "repository_dispatch"
        and run.get("display_title") == record.worker_display_title
        and run.get("head_sha") == record.worker_head_sha
        and run.get("created_at") == record.worker_created_at
        and _login(run, "actor") == "github-actions[bot]"
        and _login(run, "triggering_actor") == "github-actions[bot]"
        and production._full_name(run, "repository") == repository
        and production._full_name(run, "head_repository") == repository
        and _strict_int_equals(job.get("id"), record.worker_job_id)
        and _strict_int_equals(job.get("run_id"), run["id"])
        and _strict_int_equals(job.get("run_attempt"), 1)
        and job.get("head_sha") == record.worker_head_sha
        and job.get("head_branch") == "main"
        and job.get("name") == JOB
        and job.get("status") == "completed"
        and job.get("conclusion") == "failure"
        and job.get("started_at") == record.worker_job_started_at
        and job.get("completed_at") == record.worker_job_completed_at
        and production._steps_match(job, clock_bound=True)
        and _record_source_matches(record, source_blobs, workflow_blob)
        and _clock_proof_matches(record, run, clock_proof)
    )


def qualify_guard_run(
    repository,
    environment,
    run,
    job,
    log,
    source_blobs,
    workflow_blob,
    *,
    clock_proof,
    _record=None,
):
    """Qualify only an exact recorded clock-bound pre-mutation refusal."""
    if not isinstance(run, dict) or not isinstance(job, dict):
        return None
    record = _record or CLOCK_BOUND_RECORDS.get(run.get("id"))
    if (
        not isinstance(record, ClockBoundRecord)
        or environment != ENVIRONMENT
        or not _clock_bound_run_matches(
            repository,
            run,
            job,
            source_blobs,
            workflow_blob,
            clock_proof,
            record=record,
        )
    ):
        return None
    rows = production._raw_rows(log, job)
    checkout = production.actual_checkout(log, job, clock_bound=True)
    expected_checkout = record.worker_checkout_sha or record.worker_head_sha
    if (
        rows is None
        or checkout != expected_checkout
        or not production._guard_failure(
            rows,
            job,
            expected_diagnostic_sha256=record.diagnostic_sha256,
            clock_bound=True,
        )
    ):
        return None
    return {
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "job_id": job["id"],
        "checkout_sha": checkout,
        "qualification": "no_provider_mutation",
        "clock_run_id": record.clock.run_id,
    }


def _require(owner, condition, message):
    if not condition:
        raise owner.retention.UnsafeState(message)


def clock_witness(owner, repository, record):
    """Read the exact attempt, jobs, and source profile bound to one clock row."""
    clock = owner.api(repository, f"runs/{record.clock.run_id}/attempts/1")
    result = owner.api(
        repository, f"runs/{record.clock.run_id}/jobs?filter=latest&per_page=100"
    )
    rows = result.get("jobs")
    _require(
        owner,
        isinstance(rows, list)
        and result.get("total_count") == len(rows)
        and len(rows) <= 100
        and all(isinstance(row, dict) for row in rows),
        "maintenance job inventory is incomplete",
    )
    check = [row for row in rows if row.get("id") == record.clock.check_job_id]
    wake = [row for row in rows if row.get("id") == record.clock.wake_job_id]
    _require(
        owner, len(check) == len(wake) == 1, "maintenance clock jobs are ambiguous"
    )
    workflow = json.loads(
        owner.command(
            "gh",
            "api",
            f"repos/{repository}/contents/{CLOCK_WORKFLOW}?ref={record.clock.head_sha}",
            "--jq",
            "{sha,size}",
        )
    )
    return {
        "run": clock,
        "check_job": check[0],
        "wake_job": wake[0],
        "workflow_blob": workflow,
    }


def qualify_publication(
    owner,
    repository,
    run,
    job,
    attempt,
    *,
    log_reader,
    source_reader,
    actor_validator,
    workflow_path,
):
    """Qualify a listed clock tick before publication source reads or cleanup."""
    record = CLOCK_BOUND_RECORDS.get(attempt.get("id"))
    proof = None
    if record is None:
        import retention_production_profile_evidence as profile

        # A job for another source cannot match this immutable worker profile.
        if job.get("head_sha") != attempt.get("head_sha"):
            return None
        actor_validator(owner, attempt, run, attempt.get("run_attempt", 1), ENVIRONMENT)
        record, proof = profile.discover_record(owner, repository, attempt, job)
    else:
        actor_validator(owner, attempt, run, attempt.get("run_attempt", 1), ENVIRONMENT)
    log = log_reader(owner, job)
    checkout = production.actual_checkout(log, job, clock_bound=True)
    expected_checkout = record.worker_checkout_sha or record.worker_head_sha
    _require(
        owner,
        checkout is not None and checkout == expected_checkout,
        "maintenance runner or checkout is unproved",
    )
    blobs = source_reader(owner, repository, checkout, SOURCE_PATHS)
    workflow_blob = json.loads(
        owner.command(
            "gh",
            "api",
            f"repos/{repository}/contents/{workflow_path}?ref={run['head_sha']}",
            "--jq",
            "{sha,size}",
        )
    )
    if not _record_source_matches(record, blobs, workflow_blob):
        return None
    if proof is None:
        proof = clock_witness(owner, repository, record)
    return qualify_guard_run(
        repository,
        ENVIRONMENT,
        attempt,
        job,
        log,
        blobs,
        workflow_blob,
        clock_proof=proof,
        _record=record,
    )
