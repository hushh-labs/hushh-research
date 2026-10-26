"""Prove maintenance publication or a frozen pre-mutation failure; no cleanup authority."""

from __future__ import annotations

import importlib
import json
import os
import re

WORKFLOW = ".github/workflows/capacity-maintenance.yml"
REPOSITORY = "hushh-labs/hushh-research"
# Reviewed legacy owners publish checkpoint_ready before every provider mutation.
# Their actual checkout, not the workflow run's head, selects this frozen proof.
LEGACY_BLOBS = {
    "scripts/ci/uat-retention-maintenance.py": (
        "17b8ac515413c893efa980d3cd74301af09762ca",
        88790,
    ),
    WORKFLOW: ("3345c20d2ec1f7d33e5665596af8878e9c9a538e", 13614),
}
REASONS = {
    "Hosted maintenance stopped: Drive worker is not ready",
    "Hosted maintenance stopped: Maintenance exited without publishing its checkpoint; operator reconciliation required",
}
LEGACY_STEPS = (
    "Set up job",
    "Checkout mutation tooling and rollback history",
    "Start the five-minute cleanup budget",
    "Recheck due source under the deployment lock",
    "Authenticate to uat",
    "Set up Cloud SDK",
    "Prepare or finish eligible uat revision cleanup",
    "Save uat cleanup checkpoint",
    "Report cleanup independently of release health",
    "Post Authenticate to uat",
    "Post Checkout mutation tooling and rollback history",
    "Complete job",
)
ANSI = re.compile(r"\x1b\[[0-9;]*m")
RUNNER_WARNING = "##[warning]Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: google-github-actions/auth@v2, google-github-actions/setup-gcloud@v2. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/"


def _require(owner, condition, message):
    if not condition:
        raise owner.retention.UnsafeState(message)


def _jobs(owner, repository, run, number):
    endpoint = (
        f"runs/{run['id']}/jobs?filter=latest&per_page=100"
        if number == run.get("run_attempt", 1)
        else f"runs/{run['id']}/attempts/{number}/jobs?per_page=100"
    )
    result = owner.api(repository, endpoint)
    rows = result.get("jobs")
    _require(
        owner,
        isinstance(rows, list)
        and result.get("total_count") == len(rows)
        and len(rows) <= 100
        and all(isinstance(row, dict) for row in rows),
        "maintenance job inventory is incomplete",
    )
    return rows


def _steps(owner, job):
    rows = job.get("steps", [])
    _require(
        owner,
        isinstance(rows, list)
        and len(rows) <= 500
        and all(
            isinstance(row, dict) and isinstance(row.get("name"), str) for row in rows
        ),
        "maintenance step inventory is incomplete",
    )
    indexed = {row["name"]: row for row in rows}
    _require(owner, len(indexed) == len(rows), "maintenance steps are ambiguous")
    return indexed


def _current(run, number, job, environment):
    return (
        str(run["id"]) == os.getenv("GITHUB_RUN_ID")
        and str(number) == os.getenv("GITHUB_RUN_ATTEMPT")
        and os.getenv("GITHUB_REPOSITORY")
        == (run.get("repository") or {}).get("full_name")
        and os.getenv("GITHUB_JOB")
        == ("uat-maintenance" if environment == "uat" else "cleanup")
        and job.get("run_id") == run["id"]
        and job.get("run_attempt") == number
        and job.get("head_sha") == run.get("head_sha")
        and job.get("status") == "in_progress"
    )


def _log(owner, job):
    reader = importlib.import_module("verify-predecessor-acceptance")
    _require(
        owner, reader.REPOSITORY == REPOSITORY, "maintenance log repository changed"
    )
    remaining = owner.retention.remaining_seconds(owner.GITHUB_LOOKUP_SECONDS)
    deadline = owner._LOOKUP_DEADLINE.get()
    if deadline is not None:
        remaining = min(remaining, deadline - owner.time.monotonic())
    _require(owner, remaining > 0, "maintenance proof lookup exceeded its deadline")
    try:
        raw = reader.bounded_github_read(
            f"jobs/{job['id']}/logs", remaining, allow_escape_sequences=True
        )
    except reader.Refused as error:
        raise owner.retention.UnsafeState(
            "maintenance bounded log lookup failed"
        ) from error
    _require(
        owner,
        isinstance(raw, bytes) and 0 < len(raw) <= 2 * 1024 * 1024,
        "maintenance logs are missing or exceed their bound",
    )
    return raw.decode("utf-8-sig")


def _lines(owner, text, job):
    started, completed = (
        owner._github_timestamp(job.get(key)) for key in ("started_at", "completed_at")
    )
    rows = []
    for line in text.splitlines():
        timestamp, separator, body = line.partition(" ")
        stamp = owner._github_timestamp(timestamp)
        _require(
            owner,
            separator
            and stamp is not None
            and started is not None
            and completed is not None
            and started <= stamp <= completed
            and (not rows or stamp >= rows[-1][0]),
            "maintenance logs are incomplete or unordered",
        )
        rows.append((stamp, ANSI.sub("", body)))
    finalized = bool(rows) and rows[-1][1] == "Cleaning up orphan processes"
    if len(rows) >= 2 and rows[-1][1] == RUNNER_WARNING:
        finalized = rows[-2][1] == "Cleaning up orphan processes"
    _require(
        owner,
        rows and rows[0][1].startswith("Current runner version:") and finalized,
        "maintenance runner finalization is unproved",
    )
    forbidden = (
        "Unable to process file command",
        "Invalid format",
        "The operation was canceled",
        "The operation was cancelled",
        "checkpoint_ready=true",
    )
    _require(
        owner,
        not any(token in body for _, body in rows for token in forbidden),
        "maintenance output or cancellation outcome is uncertain",
    )
    return rows


def _checkout(owner, rows, step):
    started, completed = (
        owner._github_timestamp(step.get(key)) for key in ("started_at", "completed_at")
    )
    if completed is not None:
        completed += owner.timedelta(
            seconds=1
        )  # Actions step times have second precision.
    part = [
        body
        for stamp, body in rows
        if started is not None
        and completed is not None
        and started <= stamp <= completed
    ]
    commands = [
        i
        for i, body in enumerate(part)
        if body == "[command]/usr/bin/git log -1 --format=%H"
    ]
    _require(
        owner,
        len(commands) == 1 and commands[0] + 1 < len(part),
        "maintenance actual checkout is unproved",
    )
    sha = part[commands[0] + 1]
    _require(
        owner,
        bool(re.fullmatch(r"[0-9a-f]{40}", sha)),
        "maintenance checkout SHA is invalid",
    )
    return sha


def _source(owner, repository, checkout, workflow_sha):
    bindings = {(path, checkout) for path in LEGACY_BLOBS} | {(WORKFLOW, workflow_sha)}
    for path, sha in sorted(bindings):
        digest, size = LEGACY_BLOBS[path]
        value = json.loads(
            owner.command(
                "gh",
                "api",
                f"repos/{repository}/contents/{path}?ref={sha}",
                "--jq",
                "{sha,size}",
            )
        )
        _require(
            owner,
            value == {"sha": digest, "size": size},
            "maintenance pre-mutation source is unknown",
        )


def _legacy_origin(owner, repository, run, number, job, steps, environment):
    attempt = owner.api(repository, f"runs/{run['id']}/attempts/{number}")
    _require(
        owner,
        attempt.get("status") == "completed"
        and attempt.get("conclusion") == "failure"
        and all(
            attempt.get(key) == run.get(key)
            for key in (
                "id",
                "head_sha",
                "path",
                "head_branch",
                "event",
                "repository",
                "head_repository",
            )
        )
        and attempt.get("run_attempt") == number,
        "maintenance failed attempt origin changed",
    )
    _require(
        owner,
        list(steps) == list(LEGACY_STEPS)
        and type(run.get("id")) is int
        and run["id"] > 0
        and job.get("conclusion") == "failure"
        and type(job.get("id")) is int
        and job["id"] > 0
        and bool(re.fullmatch(r"[0-9a-f]{40}", attempt.get("head_sha", "")))
        and all(
            job.get(key) == value
            for key, value in {
                "run_id": run["id"],
                "run_attempt": number,
                "head_sha": attempt["head_sha"],
                "head_branch": "main",
            }.items()
        ),
        "maintenance legacy job is not exactly bound",
    )
    for name, step in steps.items():
        wanted = (
            "failure"
            if name == "Prepare or finish eligible uat revision cleanup"
            else ("skipped" if name == "Save uat cleanup checkpoint" else "success")
        )
        _require(
            owner,
            step.get("status") == "completed" and step.get("conclusion") == wanted,
            "maintenance legacy step finalization is unproved",
        )
    _legacy_actor(owner, attempt, run, number, environment)


def _legacy_actor(owner, attempt, run, number, environment):
    policy = json.loads(
        (
            owner.Path(owner.__file__).resolve().parents[2]
            / "config/ci-governance.json"
        ).read_text()
    )
    actor = (attempt.get("actor") or {}).get("login")
    users = policy[environment]["manual_dispatch_users"]
    _require(
        owner,
        attempt.get("event") in {"schedule", "repository_dispatch", "workflow_dispatch"}
        and (
            actor in users
            or (
                attempt.get("event") == "repository_dispatch"
                and actor == "github-actions[bot]"
                and run.get("display_title") == owner.SCOPED_TICK_TITLES[environment]
            )
        )
        and (
            number == 1 or (attempt.get("triggering_actor") or {}).get("login") in users
        ),
        "maintenance legacy actor is ungoverned",
    )


def _legacy_no_effect(owner, repository, run, number, job, steps, environment):
    """Only a complete frozen runner transcript proves the checkpoint barrier was not crossed."""
    if environment != "uat" or repository != REPOSITORY:
        return False
    _legacy_origin(owner, repository, run, number, job, steps, environment)
    rows = _lines(owner, _log(owner, job), job)
    sha = _checkout(
        owner, rows, steps["Checkout mutation tooling and rollback history"]
    )
    _source(owner, repository, sha, run["head_sha"])
    cleanup = steps["Prepare or finish eligible uat revision cleanup"]
    start, end = (
        owner._github_timestamp(cleanup.get(key))
        for key in ("started_at", "completed_at")
    )
    if end is not None:
        end += owner.timedelta(seconds=1)
    errors = [
        body
        for stamp, body in rows
        if start is not None
        and end is not None
        and start <= stamp <= end
        and body.startswith("Hosted maintenance stopped:")
    ]
    _require(
        owner,
        len(errors) == 1 and errors[0] in REASONS,
        "maintenance pre-checkpoint failure is unproved",
    )
    _require(
        owner,
        sum(
            body == "##[error]Process completed with exit code 1."
            for stamp, body in rows
            if start <= stamp <= end
        )
        == 1,
        "maintenance command failure finalization is unproved",
    )
    print(
        "maintenance_publication_proof="
        + json.dumps(
            {
                "run_id": run["id"],
                "attempt": number,
                "job_id": job["id"],
                "checkout_sha": sha,
                "qualification": "no_provider_mutation",
            },
            sort_keys=True,
        )
    )
    return True


def _attempt(owner, repository, run, number, environment):
    rows = _jobs(owner, repository, run, number)
    name = (
        "UAT" if environment == "uat" else "Production"
    ) + " bounded revision cleanup"
    legacy = (
        "UAT" if environment == "uat" else "Production"
    ) + " revision maintenance (no drain wait)"
    if any(row.get("name") == legacy for row in rows):
        return True
    selected = [row for row in rows if row.get("name") == name]
    _require(owner, len(selected) <= 1, "maintenance cleanup job is ambiguous")
    if not selected:
        return False
    job = selected[0]
    if _current(run, number, job, environment):
        return False
    if job.get("status") in {"queued", "waiting", "pending"}:
        return False
    _require(
        owner,
        job.get("status") == "completed",
        "An earlier environment maintenance job is still active",
    )
    steps = _steps(owner, job)
    if job.get("conclusion") == "skipped" and not steps:
        return False
    _require(
        owner,
        f"Prepare or finish eligible {environment} revision cleanup" in steps,
        "maintenance cleanup invocation is missing",
    )
    attempt = steps.get(
        f"Prepare or finish eligible {environment} revision cleanup", {}
    )
    if attempt.get("conclusion") == "skipped":
        return False
    saved = steps.get(f"Save {environment} cleanup checkpoint", {}).get("conclusion")
    if saved == "success":
        _require(
            owner,
            owner.trusted_checkpoint_run(repository, run, environment),
            "maintenance checkpoint source is untrusted",
        )
        return True
    if saved == "skipped" and attempt.get("conclusion") == "success":
        return False
    _require(
        owner,
        saved == "skipped"
        and _legacy_no_effect(owner, repository, run, number, job, steps, environment),
        "Maintenance exited without publishing its checkpoint; operator reconciliation required",
    )
    return False


def assert_published(owner, repository, environment):
    """Keep all attempts before a published boundary; a newer no-effect failure clears nothing."""
    other = owner.SCOPED_TICK_TITLES["production" if environment == "uat" else "uat"]
    for page in range(1, 11):
        result = owner.api(
            repository,
            f"workflows/capacity-maintenance.yml/runs?branch=main&per_page=100&page={page}",
        )
        runs = result.get("workflow_runs")
        _require(owner, isinstance(runs, list), "maintenance history is invalid")
        for run in sorted(runs, key=lambda item: item["id"], reverse=True):
            if (
                run.get("path") != WORKFLOW
                or run.get("head_branch") != "main"
                or (run.get("repository") or {}).get("full_name") != repository
                or (run.get("head_repository") or {}).get("full_name") != repository
            ):
                continue
            if (
                run.get("event") == "repository_dispatch"
                and run.get("display_title") == other
            ):
                continue
            count = run.get("run_attempt", 1)
            _require(
                owner,
                type(count) is int and 1 <= count <= 10,
                "maintenance attempt inventory exceeds bounded lookup",
            )
            published = False
            for number in range(count, 0, -1):
                published = (
                    _attempt(owner, repository, run, number, environment) or published
                )
            if published:
                return
        if len(runs) < 100:
            return
    raise owner.retention.UnsafeState(
        "maintenance checkpoint history exceeds bounded inventory"
    )


def begin(owner, args, repository, run_id):
    """Publish an unfinished existing journal before live health; preserve restored intents."""
    observed = (
        owner.latest_deploy_observation(repository, args.environment)
        if args.apply
        else None
    )
    services = owner.production_retention_context.services(owner, args)
    pending = list(services)
    if args.apply:
        (args.state_dir / "README.txt").write_text(
            f"{args.environment} drain evidence; never deployment authority.\n"
        )
        owner.checkpoint(args, run_id, observed, pending, "in_progress")
    return observed, services, pending
