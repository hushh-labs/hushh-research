"""Qualify one production checkpoint-guard refusal as pre-mutation, without authority.

Under the reviewed maintenance owner, an --apply pass calls
assert_checkpoint_publication before restore_state or any provider mutation, and
both accepted diagnostics are raised only through that guard. A complete raw job
transcript whose prepare step ends with exactly one of them therefore proves only
that this attempt left revision-cleanup custody unchanged. The earlier operational
reference step keeps its own intent artifact and idempotent tag readback. Nothing
here grants cleanup, tag, traffic or reconciliation authority; older custody is
still walked, and unknown evidence remains a refusal.
"""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta
from typing import Any

import retention_preflight_evidence as base

ENVIRONMENT = "production"
JOB = "Production bounded revision cleanup"
PREPARE = "Prepare or finish eligible production revision cleanup"
SAVE = "Save production cleanup checkpoint"
REPORT = "Report cleanup independently of release health"
PUBLICATION = "scripts/ci/retention_publication.py"
SOURCE_PATHS = (base.OWNER, base.WORKFLOW, PUBLICATION)
STEP_NAMES = (
    "Set up job",
    base._CHECKOUT,
    "Prepare operational database verification runtime",
    "Select maintenance Python runtime",
    "Install operational Cloud SQL Auth Proxy",
    "Start the five-minute cleanup budget",
    "Recheck due source under the deployment lock",
    "Authenticate to production",
    "Set up Cloud SDK",
    "Publish operational backend reference under deployment lock",
    PREPARE,
    SAVE,
    REPORT,
    "Post Authenticate to production",
    "Post Prepare operational database verification runtime",
    "Post Checkout mutation tooling and rollback history",
    "Complete job",
)
PREPARE_COMMAND = (
    "##[group]Run set -euo pipefail",
    "set -euo pipefail",
    "flags=()",
    'if [ "$APPLY" = true ]; then flags=(--apply); fi',
    'if [[ "$CAPACITY_BRIDGE" = true ]]; then flags+=(--production-capacity-bridge); fi',
    'if [[ "$GITHUB_EVENT_NAME" = workflow_dispatch ]]; then flags+=(--force-inspection); fi',
    "python3 scripts/ci/uat-retention-maintenance.py --environment production \\",
    '  --release-run-id "$RELEASE_RUN_ID" \\',
    '  --qualified-cold-checkpoint-run-id "$COLD_CHECKPOINT_RUN_ID" \\',
    '  --operational-backend-proof-run-id "$OPERATIONAL_RUN_ID" \\',
    '  --operational-backend-proof-attempt "$OPERATIONAL_ATTEMPT" \\',
    '  --staged-worker-run-id "$STAGED_WORKER_RUN_ID" \\',
    '  --state-dir "$RUNNER_TEMP/production-retention-state" "${flags[@]}"',
)
DIAGNOSTICS = frozenset(
    {
        "Hosted maintenance stopped: Maintenance publication proof is unavailable or invalid",
        "Hosted maintenance stopped: Maintenance exited without publishing its checkpoint; "
        "operator reconciliation required",
    }
)
# Verified with git rev-parse <commit>:<path> and git cat-file -s. The first profile is
# Main 50e52f99, the checkout of failed attempt 40949492997/1; the second differs only
# by this change's publication body. In both, --apply reaches these diagnostics only
# through assert_checkpoint_publication before restore_state or a provider mutation.
SOURCE_PROFILES = (
    {
        base.OWNER: ("e52212d40ae42212e810b7bc252bdb2c54d4c6f9", 87062),
        base.WORKFLOW: ("3c4df8484f6acaa0347b5f0c00a3fded55014e06", 20480),
        PUBLICATION: ("a972715ad36cb57e87f70c5dfff7bbf7d075e4b1", 16835),
    },
    {
        base.OWNER: ("e52212d40ae42212e810b7bc252bdb2c54d4c6f9", 87062),
        base.WORKFLOW: ("3c4df8484f6acaa0347b5f0c00a3fded55014e06", 20480),
        PUBLICATION: ("700c61e5abf510451f84ead3c74f09a0d087e5eb", 17407),
    },
)

# GitHub prints this setup action input's multi-line default without line stamps.
# Only this exact block, directly after its exact header, inherits that header's
# stamp; every other unstamped line still refuses, and all content is still scanned.
_GLOB_HEADER = "  cache-dependency-glob: **/*requirements*.txt"
_GLOB_CONTINUATION = (
    "**/*requirements*.in",
    "**/*constraints*.txt",
    "**/*constraints*.in",
    "**/pyproject.toml",
    "**/uv.lock",
    "**/*.py.lock",
    "",
)


def _normalized(log):
    if not isinstance(log, str) or not log:
        return None
    try:
        if len(log.encode("utf-8")) > base.MAX_LOG_BYTES:
            return None
    except UnicodeError:
        return None
    lines, output, index = log.removeprefix("﻿").splitlines(), [], 0
    while index < len(lines):
        stamp, separator, body = lines[index].partition(" ")
        if not separator or base._stamp(stamp) is None:
            return None
        output.append(lines[index])
        index += 1
        block = tuple(lines[index : index + len(_GLOB_CONTINUATION)])
        if base._STYLE.sub("", body) == _GLOB_HEADER and block == _GLOB_CONTINUATION:
            output.extend(f"{stamp} {value}" for value in block)
            index += len(block)
    return "\n".join(output)


def _raw_rows(log, job):
    normalized = _normalized(log)
    return None if normalized is None else base._raw_rows(normalized, job)


def _steps_match(job: dict[str, Any], *, clock_bound: bool = False) -> bool:
    steps = job.get("steps")
    if clock_bound:
        from retention_production_clock_evidence import CLOCK_BOUND_STEP_NAMES

        names = CLOCK_BOUND_STEP_NAMES
    else:
        names = STEP_NAMES
    if not isinstance(steps, list) or len(steps) != len(names):
        return False
    numbers = []
    for step, name in zip(steps, names, strict=True):
        conclusion = (
            {
                "Prepare operational database verification runtime": "skipped",
                "Select maintenance Python runtime": "skipped",
                "Install operational Cloud SQL Auth Proxy": "skipped",
                "Publish operational backend reference under deployment lock": "skipped",
                PREPARE: "failure",
                SAVE: "skipped",
            }.get(name, "success")
            if clock_bound
            else "failure"
            if name == PREPARE
            else "skipped"
            if name == SAVE
            else "success"
        )
        if (
            not isinstance(step, dict)
            or step.get("name") != name
            or step.get("status") != "completed"
            or step.get("conclusion") != conclusion
            or type(step.get("number")) is not int
            or step["number"] < 1
        ):
            return False
        numbers.append(step["number"])
    return numbers == sorted(set(numbers))


def _step(job: dict[str, Any], name: str) -> dict[str, Any]:
    matches = [step for step in job["steps"] if step.get("name") == name]
    return matches[0] if len(matches) == 1 else {}


def _full_name(run: dict[str, Any], key: str) -> str | None:
    repository = run.get(key) if isinstance(run, dict) else None
    return repository.get("full_name") if isinstance(repository, dict) else None


def actual_checkout(
    log: str, job: dict[str, Any], *, clock_bound: bool = False
) -> str | None:
    """Extract only a complete finalized transcript's exact checkout command result."""
    rows = _raw_rows(log, job)
    if rows is None or not _steps_match(job, clock_bound=clock_bound):
        return None
    checkout = base._step_rows(rows, _step(job, base._CHECKOUT))
    commands = [i for i, body in enumerate(checkout) if body == base._CHECKOUT_COMMAND]
    if len(commands) != 1 or commands[0] + 1 >= len(checkout):
        return None
    sha = checkout[commands[0] + 1]
    return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None


def _prepare_segment(rows, job):
    prepare, report = _step(job, PREPARE), _step(job, REPORT)
    begin, finish = (base._stamp(prepare.get(key)) for key in ("started_at", "completed_at"))
    start, end = (base._stamp(report.get(key)) for key in ("started_at", "completed_at"))
    markers = [(index, at) for index, (at, body) in enumerate(rows) if body == base.REPORT_GROUP]
    if not (
        begin
        and finish
        and begin <= finish
        and start
        and end
        and start <= end
        and len(markers) == 1
        and start <= markers[0][1] < end + timedelta(seconds=1)
    ):
        return []
    segment = [(at, body) for at, body in rows[: markers[0][0]] if at >= begin]
    if not all(at < finish + timedelta(seconds=1) for at, _ in segment):
        return []
    return [body for _, body in segment]


def _guard_failure(
    rows, job, *, expected_diagnostic_sha256=None, clock_bound=False
) -> bool:
    if not _steps_match(job, clock_bound=clock_bound):
        return False
    prepare = _prepare_segment(rows, job)
    width = len(PREPARE_COMMAND)
    positions = [
        index
        for index in range(len(prepare))
        if tuple(prepare[index : index + width]) == PREPARE_COMMAND
    ]
    if len(positions) != 1 or prepare.count("  APPLY: true") != 1:
        return False
    grouped = prepare[positions[0] :]
    if grouped.count("##[endgroup]") != 1:
        return False
    tail = grouped[grouped.index("##[endgroup]") + 1 :]
    diagnostics = [
        body for _, body in rows if body.startswith("Hosted maintenance stopped:")
    ]
    errors = [body for _, body in rows if "##[error]" in body]
    diagnostic_matches = len(tail) == 2 and tail[0] in DIAGNOSTICS
    if expected_diagnostic_sha256 is not None and len(tail) == 2:
        diagnostic_matches = (
            hashlib.sha256(tail[0].encode("utf-8")).hexdigest()
            == expected_diagnostic_sha256
        )
    return (
        len(tail) == 2
        and diagnostic_matches
        and tail[1] == base._EXIT
        and diagnostics == [tail[0]]
        and errors == [base._EXIT]
    )


def _reviewed(source_blobs, workflow_blob) -> bool:
    for profile in SOURCE_PROFILES:
        expected = {
            path: {"sha": sha, "size": size} for path, (sha, size) in profile.items()
        }
        if source_blobs == expected and workflow_blob == expected[base.WORKFLOW]:
            return True
    return False


def qualify_guard_run(
    repository,
    environment,
    run,
    job,
    log,
    source_blobs,
    workflow_blob,
    clock_proof=None,
):
    """Qualify a reviewed manual refusal; clock events use their exact owner."""
    if isinstance(run, dict) and run.get("event") == "repository_dispatch":
        from retention_production_clock_evidence import (
            qualify_guard_run as qualify_clock,
        )

        return qualify_clock(
            repository,
            environment,
            run,
            job,
            log,
            source_blobs,
            workflow_blob,
            clock_proof=clock_proof,
        )
    if not isinstance(run, dict) or not isinstance(job, dict):
        return None
    common = (
        repository == base.REPOSITORY
        and environment == ENVIRONMENT
        and run.get("event") == "workflow_dispatch"
        and run.get("status") == "completed"
        and run.get("conclusion") == "failure"
        and run.get("path") == base.WORKFLOW
        and run.get("head_branch") == "main"
        and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        and all(
            type(value) is int and value > 0
            for value in (run.get("id"), run.get("run_attempt"), job.get("id"))
        )
        and run["run_attempt"] <= 10
        and all(
            _full_name(run, key) == repository
            for key in ("repository", "head_repository")
        )
    )
    if (
        not common
        or not _reviewed(source_blobs, workflow_blob)
        or not _steps_match(job)
    ):
        return None
    if not (
        job.get("name") == JOB
        and job.get("status") == "completed"
        and job.get("conclusion") == "failure"
        and job.get("head_branch") == "main"
        and job.get("run_id") == run["id"]
        and type(job.get("run_attempt")) is int
        and job.get("run_attempt") == run["run_attempt"]
        and job.get("head_sha") == run["head_sha"]
    ):
        return None
    rows = _raw_rows(log, job)
    checkout = actual_checkout(log, job)
    if rows is None or checkout is None or not _guard_failure(rows, job):
        return None
    return {
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "job_id": job["id"],
        "checkout_sha": checkout,
        "qualification": "no_provider_mutation",
    }
