"""Qualify an exact, immutable production source-profile history row."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from datetime import timedelta
from urllib.parse import urlencode

import retention_preflight_evidence as base
import retention_production_clock_records as records
import retention_production_evidence as production

APPROVED_SOURCE_SHA = "8053f691444593c83aa7e01cab2d88727820287b"
PROFILE_NAME = "publication-84b"
PROFILE_TEMPLATE_RUN_ID = 41489711406
MAX_CLOCK_RUNS = 100
MAX_COMPARE_COMMITS = 250
MAX_LOOKBACK = timedelta(hours=3)
CHECK_NAME = "Check for due maintenance without cloud credentials"
WAKE_NAME = "Wake Capacity Maintenance for due work"
REARM_NAME = "Re-arm the clock after its wait"
EXPECTED_CLOCK_JOBS = frozenset({CHECK_NAME, WAKE_NAME, REARM_NAME})
WORKER_TITLES = frozenset(
    {"Capacity Maintenance", "Capacity Maintenance tick (production)"}
)
_RUN_FIELDS = (
    "id",
    "run_attempt",
    "event",
    "path",
    "head_branch",
    "head_sha",
    "created_at",
    "status",
    "conclusion",
    "display_title",
    "actor",
    "triggering_actor",
    "repository",
    "head_repository",
)


def _require(owner, condition, message):
    if not condition:
        raise owner.retention.UnsafeState(message)


def _positive_int(value):
    return type(value) is int and value > 0


def _login(run, key):
    actor = run.get(key) if isinstance(run, dict) else None
    return actor.get("login") if isinstance(actor, dict) else None


def _trusted_repo_pair(run, repository):
    return all(
        isinstance(run.get(key), dict)
        and run[key].get("full_name") == repository
        for key in ("repository", "head_repository")
    )


def _valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def _is_ancestor(owner, repository, ancestor, descendant):
    """Prove ancestry through one bounded GitHub compare response."""
    _require(
        owner,
        repository == base.REPOSITORY and _valid_sha(ancestor) and _valid_sha(descendant),
        "production source ancestry identity is invalid",
    )
    if ancestor == descendant:
        return True
    response = owner.command(
        "gh",
        "api",
        f"repos/{repository}/compare/{ancestor}...{descendant}?per_page={MAX_COMPARE_COMMITS}",
        "--jq",
        "{status,ahead_by,behind_by,total_commits,commit_count:(.commits|length)}",
    )
    try:
        result = json.loads(response)
    except (TypeError, ValueError):
        raise owner.retention.UnsafeState(
            "production source ancestry evidence is invalid"
        ) from None
    status = result.get("status") if isinstance(result, dict) else None
    ahead = result.get("ahead_by") if isinstance(result, dict) else None
    behind = result.get("behind_by") if isinstance(result, dict) else None
    total = result.get("total_commits") if isinstance(result, dict) else None
    count = result.get("commit_count") if isinstance(result, dict) else None
    _require(
        owner,
        status == "ahead"
        and type(ahead) is int
        and 0 < ahead <= MAX_COMPARE_COMMITS
        and type(behind) is int
        and behind == 0
        and type(total) is int
        and total == ahead
        and type(count) is int
        and count == total,
        "production source ancestry is not bounded and exact",
    )
    return True


def _read_blob(owner, repository, path, ref):
    _require(
        owner,
        repository == base.REPOSITORY and _valid_sha(ref),
        "production source blob reference is invalid",
    )
    response = owner.command(
        "gh",
        "api",
        f"repos/{repository}/contents/{path}?ref={ref}",
        "--jq",
        "{sha,size}",
    )
    try:
        blob = json.loads(response)
    except (TypeError, ValueError):
        raise owner.retention.UnsafeState(
            "production source blob evidence is invalid"
        ) from None
    _require(
        owner,
        isinstance(blob, dict)
        and _valid_sha(blob.get("sha"))
        and type(blob.get("size")) is int
        and blob["size"] >= 0,
        "production source blob evidence is incomplete",
    )
    return blob


def _run_matches(summary, attempt):
    # GitHub's run list and attempt endpoint can differ by one second for the
    # same first attempt (observed on 41537628196). Keep identity/source exact;
    # admit only that bounded timestamp representation difference.
    created = base._stamp(summary.get("created_at"))
    attempted = base._stamp(attempt.get("created_at")) if isinstance(attempt, dict) else None
    return bool(
        isinstance(attempt, dict)
        and all(summary.get(key) == attempt.get(key) for key in _RUN_FIELDS if key != "created_at")
        and created is not None and attempted is not None
        and timedelta(0) <= attempted - created <= timedelta(seconds=2)
        and _positive_int(summary.get("id"))
        and _positive_int(attempt.get("id"))
        and type(summary.get("run_attempt")) is int
        and type(attempt.get("run_attempt")) is int
    )


def _worker_is_exact(owner, repository, run, job):
    exact = bool(
        repository == base.REPOSITORY
        and isinstance(run, dict)
        and isinstance(job, dict)
        and _positive_int(run.get("id"))
        and type(run.get("run_attempt")) is int
        and run.get("run_attempt") == 1
        and run.get("event") == "repository_dispatch"
        and run.get("path") == base.WORKFLOW
        and run.get("head_branch") == "main"
        and _valid_sha(run.get("head_sha"))
        and run.get("status") == "completed"
        and run.get("conclusion") == "failure"
        and run.get("display_title") in WORKER_TITLES
        and _login(run, "actor") == "github-actions[bot]"
        and _login(run, "triggering_actor") == "github-actions[bot]"
        and _trusted_repo_pair(run, repository)
        and _positive_int(job.get("id"))
        and type(job.get("run_id")) is int
        and job.get("run_id") == run.get("id")
        and type(job.get("run_attempt")) is int
        and job.get("run_attempt") == 1
        and job.get("head_sha") == run.get("head_sha")
        and job.get("head_branch") == "main"
        and job.get("name") == production.JOB
        and job.get("status") == "completed"
        and job.get("conclusion") == "failure"
        and base._stamp(run.get("created_at")) is not None
        and base._stamp(job.get("started_at")) is not None
        and base._stamp(job.get("completed_at")) is not None
    )
    return exact and _is_ancestor(owner, repository, APPROVED_SOURCE_SHA, run["head_sha"])


def _inventory(owner, repository, worker_run):
    created = base._stamp(worker_run.get("created_at"))
    _require(owner, created is not None, "maintenance worker timestamp is invalid")
    cutoff = (created - MAX_LOOKBACK).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )
    query = urlencode(
        {
            "branch": "main",
            "event": "repository_dispatch",
            "created": f">={cutoff}",
            "per_page": MAX_CLOCK_RUNS,
        }
    )
    result = owner.api(
        repository, f"workflows/capacity-maintenance-clock.yml/runs?{query}"
    )
    rows = result.get("workflow_runs") if isinstance(result, dict) else None
    total = result.get("total_count") if isinstance(result, dict) else None
    _require(
        owner,
        isinstance(rows, list)
        and type(total) is int
        and total == len(rows)
        and len(rows) <= MAX_CLOCK_RUNS
        and all(isinstance(row, dict) for row in rows),
        "capacity clock run inventory is incomplete",
    )
    return rows, created


def _clock_rows(owner, repository, summary):
    run_id = summary.get("id")
    _require(owner, _positive_int(run_id), "capacity clock run identity is invalid")
    attempt = owner.api(repository, f"runs/{run_id}/attempts/1")
    _require(
        owner,
        _run_matches(summary, attempt),
        "capacity clock run changed during evidence lookup",
    )
    result = owner.api(repository, f"runs/{run_id}/jobs?filter=latest&per_page=100")
    rows = result.get("jobs") if isinstance(result, dict) else None
    total = result.get("total_count") if isinstance(result, dict) else None
    _require(
        owner,
        isinstance(rows, list)
        and type(total) is int
        and total == len(rows)
        and len(rows) <= 100
        and all(isinstance(row, dict) for row in rows),
        "capacity clock job inventory is incomplete",
    )
    return attempt, rows


def _profile_template(owner):
    template = records.CLOCK_BOUND_RECORDS.get(PROFILE_TEMPLATE_RUN_ID)
    _require(
        owner,
        template is not None
        and template.worker_head_sha == APPROVED_SOURCE_SHA
        and template.source_profile == PROFILE_NAME
        and template.wake_overlap_seconds == 0,
        "approved production source profile is unavailable",
    )
    return template


def _dynamic_record(owner, template, worker, job, clock_run, check, wake):
    from retention_production_clock_records import ClockEvidence

    tick = _named_step(wake, "Send one capacity-maintenance-tick")
    _require(
        owner,
        _positive_int(clock_run.get("id"))
        and all(
            isinstance(clock_run.get(key), str)
            for key in ("event", "display_title", "head_sha", "created_at")
        )
        and _positive_int(check.get("id"))
        and _positive_int(wake.get("id"))
        and all(
            isinstance(job.get(key), str)
            for job in (check, wake)
            for key in ("completed_at",)
        )
        and isinstance(tick.get("completed_at"), str),
        "capacity clock timestamps or IDs are incomplete",
    )
    clock = ClockEvidence(
        run_id=clock_run["id"],
        event=clock_run["event"],
        title=clock_run["display_title"],
        actor=_login(clock_run, "actor"),
        head_sha=clock_run["head_sha"],
        created_at=clock_run["created_at"],
        check_job_id=check["id"],
        check_completed_at=check["completed_at"],
        wake_job_id=wake["id"],
        wake_completed_at=wake["completed_at"],
        tick_completed_at=tick["completed_at"],
    )
    return replace(
        template,
        worker_head_sha=worker["head_sha"],
        worker_created_at=worker["created_at"],
        worker_job_id=job["id"],
        worker_job_started_at=job["started_at"],
        worker_job_completed_at=job["completed_at"],
        worker_checkout_sha=worker["head_sha"],
        worker_display_title=worker["display_title"],
        wake_overlap_seconds=0,
        clock=clock,
    )


def _named_step(job, name):
    rows = job.get("steps") if isinstance(job, dict) else None
    if not isinstance(rows, list):
        return {}
    matches = [row for row in rows if isinstance(row, dict) and row.get("name") == name]
    return matches[0] if len(matches) == 1 else {}


def _job_names(owner, jobs):
    names = [job.get("name") for job in jobs]
    _require(
        owner,
        all(isinstance(name, str) for name in names) and len(set(names)) == len(names),
        "capacity clock jobs are ambiguous",
    )
    return set(names)


def _clock_candidates(owner, repository, worker_run, worker_job):
    import retention_production_clock_evidence as clock_evidence

    rows, worker_created = _inventory(owner, repository, worker_run)
    candidates = []
    for summary in rows:
        _require(
            owner,
            summary.get("path") == clock_evidence.CLOCK_WORKFLOW
            and summary.get("event") == "repository_dispatch"
            and summary.get("head_branch") == "main"
            and _trusted_repo_pair(summary, repository)
            and base._stamp(summary.get("created_at")) is not None,
            "capacity clock inventory contains an unknown run",
        )
        created = base._stamp(summary["created_at"])
        if created > worker_created:
            continue
        attempt, jobs = _clock_rows(owner, repository, summary)
        names = _job_names(owner, jobs)
        if not {CHECK_NAME, WAKE_NAME} <= names:
            continue
        check_rows = [job for job in jobs if job.get("name") == CHECK_NAME]
        wake_rows = [job for job in jobs if job.get("name") == WAKE_NAME]
        _require(
            owner,
            len(check_rows) == len(wake_rows) == 1,
            "capacity clock check or wake job is ambiguous",
        )
        check, wake = check_rows[0], wake_rows[0]
        record = _dynamic_record(
            owner, _profile_template(owner), worker_run, worker_job, summary, check, wake
        )
        adjacent = clock_evidence._dispatch_timing_matches(record, worker_run, check, wake)
        if adjacent:
            candidates.append((summary, attempt, jobs, check, wake, record))
    _require(owner, len(candidates) == 1, "capacity clock cause is missing or ambiguous")
    return candidates[0]


def _clock_proof(owner, repository, worker_run, candidate):
    import retention_production_clock_evidence as clock_evidence

    summary, attempt, jobs, check, wake, record = candidate
    _require(
        owner,
        _job_names(owner, jobs) == EXPECTED_CLOCK_JOBS,
        "capacity clock job inventory changed",
    )
    _require(
        owner,
        attempt.get("run_attempt") == 1
        and _valid_sha(attempt.get("head_sha"))
        and _login(attempt, "actor") == "github-actions[bot]"
        and _login(attempt, "triggering_actor") == "github-actions[bot]"
        and re.fullmatch(
            r"Capacity clock · repository_dispatch · run [1-9][0-9]*",
            str(attempt.get("display_title", "")),
        ) is not None,
        "capacity clock source or identity is unapproved",
    )
    clock_head = attempt["head_sha"]
    _is_ancestor(owner, repository, clock_head, worker_run["head_sha"])
    template = _profile_template(owner)
    expected_sources = records.CLOCK_BOUND_SOURCE_PROFILES[template.source_profile]
    actual_sources = {
        path: _read_blob(owner, repository, path, clock_head)
        for path in expected_sources
    }
    workflow_blob = _read_blob(owner, repository, clock_evidence.CLOCK_WORKFLOW, clock_head)
    proof = {
        "run": attempt,
        "check_job": check,
        "wake_job": wake,
        "workflow_blob": workflow_blob,
    }
    _require(
        owner,
        actual_sources
        == {
            path: {"sha": sha, "size": size}
            for path, (sha, size) in expected_sources.items()
        }
        and workflow_blob
        == {"sha": clock_evidence.CLOCK_WORKFLOW_BLOB[0], "size": clock_evidence.CLOCK_WORKFLOW_BLOB[1]}
        and clock_evidence._clock_proof_matches(record, worker_run, proof),
        "capacity clock proof is incomplete or unapproved",
    )
    return record, proof


def discover_record(owner, repository, worker_run, worker_job):
    """Build evidence for an approved source profile at a bounded Main descendant."""
    _require(
        owner,
        _worker_is_exact(owner, repository, worker_run, worker_job),
        "production source profile is not approved",
    )
    candidate = _clock_candidates(owner, repository, worker_run, worker_job)
    return _clock_proof(owner, repository, worker_run, candidate)
