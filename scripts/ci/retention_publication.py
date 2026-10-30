"""Prove maintenance publication or a frozen pre-mutation failure; no cleanup authority."""

from __future__ import annotations

import importlib
import json
import os
import retention_preflight_evidence as evidence
import retention_uat_guard_evidence as uat_guard

WORKFLOW = ".github/workflows/capacity-maintenance.yml"
REPOSITORY = "hushh-labs/hushh-research"
# Reviewed legacy owners publish checkpoint_ready before every provider mutation.
# Their actual checkout, not the workflow run's head, selects this frozen proof.
LEGACY_BLOBS = evidence.LEGACY_BLOBS
LEGACY_STEPS = evidence._STEP_NAMES
RUNNER_WARNING = evidence.RUNNER_WARNING
# The clock's tick for both environments. Its bot dispatch is the same authority
# as a scoped tick; only the run-name differs.
UNSCOPED_TICK_TITLE = "Capacity Maintenance"


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


def _source(owner, repository, sha, paths=None):
    def read(path, revision):
        return json.loads(
            owner.command(
                "gh",
                "api",
                f"repos/{repository}/contents/{path}?ref={revision}",
                "--jq",
                "{sha,size}",
            )
        )

    if paths is not None:
        return {path: read(path, sha) for path in paths}
    first = read(evidence.OWNER, sha)
    profile = evidence.SOURCE_PROFILES.get(first.get("sha"))
    if profile is None and first.get("sha") in uat_guard.OWNER_BLOBS:
        profile = uat_guard.SOURCE_PATHS
    _require(owner, profile is not None, "maintenance pre-mutation source is unknown")
    return {
        path: first if path == evidence.OWNER else read(path, sha) for path in profile
    }


def qualify(owner, repository, environment, run, job):
    """Bound I/O only; the existing pure evidence owners make the proof decision."""
    if environment not in {"uat", "production"} or repository != REPOSITORY:
        return None
    # Production's reviewed guard-only proof loads only on its own path.
    production = (
        importlib.import_module("retention_production_evidence")
        if environment == "production"
        else None
    )
    number = run.get("run_attempt", 1)
    attempt = owner.api(repository, f"runs/{run['id']}/attempts/{number}")
    _require(
        owner,
        all(
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
        ),
        "maintenance failed attempt origin changed",
    )
    _legacy_actor(owner, attempt, run, number, environment)
    log = _log(owner, job)
    checkout = (production or evidence).actual_checkout(log, job)
    _require(owner, checkout is not None, "maintenance runner or checkout is unproved")
    blobs = _source(
        owner, repository, checkout, production.SOURCE_PATHS if production else None
    )
    workflow = json.loads(
        owner.command(
            "gh",
            "api",
            f"repos/{repository}/contents/{WORKFLOW}?ref={run['head_sha']}",
            "--jq",
            "{sha,size}",
        )
    )
    if production is not None:
        return production.qualify_guard_run(
            repository, environment, attempt, job, log, blobs, workflow
        )
    return evidence.qualify_preflight_run(
        repository, environment, attempt, job, log, blobs, workflow
    ) or uat_guard.qualify_guard_run(
        repository, environment, attempt, job, log, blobs, workflow
    )


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
                and run.get("display_title")
                in {owner.SCOPED_TICK_TITLES[environment], UNSCOPED_TICK_TITLE}
            )
        )
        and (
            number == 1 or (attempt.get("triggering_actor") or {}).get("login") in users
        ),
        "maintenance legacy actor is ungoverned",
    )


def _attempt(owner, repository, run, number, environment):
    rows = _jobs(owner, repository, run, number)
    name = (
        "UAT" if environment == "uat" else "Production"
    ) + " bounded revision cleanup"
    legacy = (
        "UAT" if environment == "uat" else "Production"
    ) + " revision maintenance (no drain wait)"
    historical = [row for row in rows if row.get("name") == legacy]
    if historical:
        _require(
            owner,
            number == 1
            and len(historical) == 1
            and historical[0].get("status") == "completed",
            "pre-policy maintenance rerun requires reconciliation",
        )
        return _publication_time(owner, historical[0], historical[0])
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
        return _publication_time(
            owner, steps[f"Save {environment} cleanup checkpoint"], job
        )
    if saved == "skipped" and attempt.get("conclusion") == "success":
        return False
    proof = (
        owner.guard_only_preflight_proof(
            repository, environment, {**run, "run_attempt": number}, job
        )
        if saved == "skipped"
        else None
    )
    _require(
        owner,
        proof is not None,
        "Maintenance exited without publishing its checkpoint; operator reconciliation required",
    )
    print("maintenance_publication_proof=" + json.dumps(proof, sort_keys=True))
    return False


def _publication_time(owner, saved, job):
    completed = owner._github_timestamp(saved.get("completed_at"))
    finished = owner._github_timestamp(job.get("completed_at"))
    _require(
        owner,
        completed is not None and finished is not None and completed <= finished,
        "maintenance publication chronology is unproved",
    )
    return completed


def _inventory(owner, repository):
    """Finish bounded metadata discovery before any checkpoint can end the walk."""
    collected, seen, total = [], set(), None
    for page in range(1, 11):
        result = owner.api(
            repository,
            f"workflows/capacity-maintenance.yml/runs?branch=main&per_page=100&page={page}",
        )
        runs = result.get("workflow_runs")
        count = result.get("total_count")
        _require(
            owner,
            type(count) is int
            and 0 <= count < 1000
            and (total is None or total == count)
            and isinstance(runs, list)
            and len(runs) == min(100, count - len(collected)),
            "maintenance history is incomplete; reconciliation required",
        )
        total = count
        for run in runs:
            _require(
                owner,
                isinstance(run, dict)
                and type(run.get("id")) is int
                and run["id"] > 0
                and run["id"] not in seen,
                "maintenance history identity is ambiguous",
            )
            seen.add(run["id"])
            collected.append(run)
        if len(collected) == total:
            return collected
    raise owner.retention.UnsafeState(
        "maintenance history exceeds bounded inventory; reconciliation required"
    )


def assert_published(owner, repository, environment):
    """Inspect executions that can follow the exact published Save boundary, regardless of run ID."""
    other = owner.SCOPED_TICK_TITLES["production" if environment == "uat" else "uat"]
    relevant = []
    for run in _inventory(owner, repository):
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
        updated = owner._github_timestamp(run.get("updated_at"))
        _require(
            owner,
            updated is not None
            and run.get("status")
            in {
                "completed",
                "in_progress",
                "queued",
                "requested",
                "waiting",
                "pending",
            },
            "maintenance execution chronology is unproved",
        )
        relevant.append((updated, run))
    boundary = None
    for updated, run in sorted(
        relevant, key=lambda row: (row[0], row[1]["id"]), reverse=True
    ):
        if (
            boundary is not None
            and run.get("status") == "completed"
            and updated < boundary
        ):
            continue
        count = run.get("run_attempt", 1)
        _require(
            owner,
            type(count) is int and 1 <= count <= 10,
            "maintenance attempt inventory exceeds bounded lookup",
        )
        for number in range(count, 0, -1):
            published = _attempt(owner, repository, run, number, environment)
            if published:
                _require(
                    owner,
                    run.get("status") != "completed" or published <= updated,
                    "maintenance publication exceeds execution chronology",
                )
                boundary = max(boundary, published) if boundary else published


def begin(owner, args, repository, run_id):
    """Publish an unfinished existing journal before live health; preserve restored intents."""
    services = owner.production_retention_context.services(owner, args)
    pending = list(services)
    if args.apply and completion_receipt(owner, args.state_dir, args.environment) is None:
        if any(path.name != "README.txt" or path.is_symlink() or not path.is_file()
               for path in args.state_dir.iterdir()):
            raise owner.retention.UnsafeState("Unsettled cleanup files require reconciliation before preparation")
        owner.checkpoint(args, run_id, None, pending, "preparing")
    observed = owner.latest_deploy_observation(repository, args.environment) if args.apply else None
    if args.apply:
        (args.state_dir / "README.txt").write_text(
            f"{args.environment} drain evidence; never deployment authority.\n"
        )
        owner.checkpoint(args, run_id, observed, pending, "in_progress")
    return observed, services, pending


def completion_receipt(owner, directory, environment):
    """Validate a saved checkpoint without advancing its authority or clocks."""
    receipt = directory / "completed.json"
    if receipt.is_symlink():
        raise owner.retention.UnsafeState("cleanup completion receipt is a symlink")
    if not receipt.exists():
        return None
    if not receipt.is_file():
        raise owner.retention.UnsafeState(
            "cleanup completion receipt is not a regular file"
        )
    completed = json.loads(receipt.read_text())
    if (
        not isinstance(completed, dict)
        or completed.get("schema_version") != 1
        or completed.get("environment") != environment
        or completed.get("project") != owner.LANES[environment]["project"]
        or not (
            type(completed.get("observed_run_id")) is int and completed["observed_run_id"] > 0
            or completed.get("pass_status") == "preparing" and completed.get("checkpoint_version") == 3
            and "observed_run_id" in completed and completed["observed_run_id"] is None
        )
        or type(completed.get("release_run_id")) is not int
        or completed["release_run_id"] < 1
    ):
        raise owner.retention.UnsafeState(f"invalid {environment} completion receipt")
    status = completed.get("pass_status", "complete")
    if status not in {"complete", "in_progress", "deferred", "unresolved", "preparing"}:
        raise owner.retention.UnsafeState("invalid cleanup checkpoint status")
    if status != "complete":
        if (
            completed.get("checkpoint_version") != (3 if status == "preparing" else 2)
            or not isinstance(completed.get("pending_services"), list)
            or not set(completed["pending_services"]).issubset(
                owner.LANES[environment]["services"]
            )
        ):
            raise owner.retention.UnsafeState("invalid partial cleanup checkpoint")
    return completed


def preflight(owner, args, repository):
    found = owner.production_retention_context.find_source(
        owner, args, repository, require_live=False
    )
    if args.verify_source_only:
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with owner.Path(output).open("a") as stream:
                stream.write(f"cleanup_ready={str(found is not None).lower()}\n")
        return None
    if found is None:
        print("No eligible release artifact (or NO_OP source); no cleanup authorized.")
        owner.record_uat_cleanup_outcome(args, "no_live_source")
        return None
    run_id, release = found
    args.pending_context = release.get("_maintenance_pending_retirement")
    publication = importlib.import_module("retention_publication")
    if not getattr(args, "_restored_checkpoint_ready", False):
        args.preflight = publication.begin(owner, args, repository, run_id)
    if not owner.live_release_matches(release, environment=args.environment):
        print(
            f"Release {run_id} no longer matches live traffic; skipping stale maintenance."
        )
        owner.record_uat_cleanup_outcome(args, "no_live_source")
        return None
    if getattr(args, "_restored_checkpoint_ready", False):
        args.preflight = publication.begin(owner, args, repository, run_id)
    return found


def preserve(owner, args):
    """Republish restored custody unchanged before any due/source/health lookup."""
    if owner.completion_receipt(args.state_dir, args.environment) is not None:
        (args.state_dir / "README.txt").write_text(
            f"{args.environment} drain evidence; never deployment authority.\n"
        )
        owner.checkpoint_ready()
        args._restored_checkpoint_ready = True
