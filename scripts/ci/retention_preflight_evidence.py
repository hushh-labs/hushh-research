"""Qualify one reviewed historical checkpoint-guard failure, without authority.

The caller supplies the latest authenticated run/job, its bounded official job
log, and Git blob IDs resolved at AUDITED_SOURCE_SHA. This module performs no
I/O and never returns log text, credentials, a checkpoint, or mutation authority.
Unknown evidence remains a refusal; the ordinary checkpoint guard still owns
all other failures and the caller must continue checking older maintenance.
"""

from __future__ import annotations

import re
from typing import Any

AUDITED_SOURCE_SHA = "f454c67bceefa9829c6825a65d907f8cdd4e6069"
# Verified with git show <sha>:<path> | git hash-object --stdin. In this source,
# --apply calls assert_checkpoint_publication before restore_state or mutations.
AUDITED_SOURCE_BLOBS = {
    "scripts/ci/uat-retention-maintenance.py": "17b8ac515413c893efa980d3cd74301af09762ca",
    ".github/workflows/capacity-maintenance.yml": "3345c20d2ec1f7d33e5665596af8878e9c9a538e",
}
MAX_LOG_BYTES = 2 * 1024 * 1024
_JOB = "UAT bounded revision cleanup"
_CHECKOUT = "Checkout mutation tooling and rollback history"
_PREPARE = "Prepare or finish eligible uat revision cleanup"
_SAVE = "Save uat cleanup checkpoint"
_STEP_NAMES = (
    "Set up job",
    _CHECKOUT,
    "Start the five-minute cleanup budget",
    "Recheck due source under the deployment lock",
    "Authenticate to uat",
    "Set up Cloud SDK",
    _PREPARE,
    _SAVE,
    "Report cleanup independently of release health",
    "Post Authenticate to uat",
    "Post Checkout mutation tooling and rollback history",
    "Complete job",
)
_DIAGNOSTIC = (
    "Hosted maintenance stopped: Maintenance exited without publishing its "
    "checkpoint; operator reconciliation required"
)
_EXIT = "##[error]Process completed with exit code 1."
_CHECKOUT_COMMAND = "[command]/usr/bin/git log -1 --format=%H"
_PREPARE_COMMAND = (
    "set -euo pipefail",
    "flags=()",
    'if [ "$APPLY" = true ]; then flags=(--apply); fi',
    "python3 scripts/ci/uat-retention-maintenance.py --environment uat \\",
    '  --release-run-id "$RELEASE_RUN_ID" \\',
    '  --state-dir "$RUNNER_TEMP/uat-retention-state" "${flags[@]}"',
)
_TIMESTAMP = re.compile(r"^\ufeff?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z (.*)$")
_STYLE = re.compile(r"(?:\x1b|\^\[)\[[0-9;]*m")


def _steps_match(job: dict[str, Any]) -> bool:
    steps = job.get("steps")
    if not isinstance(steps, list) or len(steps) != len(_STEP_NAMES):
        return False
    numbers = []
    for step, name in zip(steps, _STEP_NAMES, strict=True):
        conclusion = "failure" if name == _PREPARE else "skipped" if name == _SAVE else "success"
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


def _log_matches(log: str) -> bool:
    if not isinstance(log, str) or not log or len(log) > MAX_LOG_BYTES:
        return False
    try:
        if len(log.encode("utf-8")) > MAX_LOG_BYTES:
            return False
    except UnicodeError:
        return False
    records: dict[str, list[str]] = {}
    last_step = -1
    errors = []
    diagnostics = []
    for line in log.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3 or parts[0] != _JOB or parts[1] not in _STEP_NAMES:
            return False
        step_index = _STEP_NAMES.index(parts[1])
        match = _TIMESTAMP.fullmatch(parts[2])
        if match is None or step_index < last_step or parts[1] == _SAVE:
            return False
        last_step = step_index
        content = _STYLE.sub("", match[1])
        records.setdefault(parts[1], []).append(content)
        if "Hosted maintenance stopped:" in content:
            diagnostics.append((parts[1], content))
        if "##[error]" in content:
            errors.append((parts[1], content))
    if set(records) != set(_STEP_NAMES) - {_SAVE}:
        return False
    checkout = records[_CHECKOUT]
    positions = [index for index, content in enumerate(checkout) if content == _CHECKOUT_COMMAND]
    if len(positions) != 1 or checkout[positions[0] + 1 : positions[0] + 2] != [AUDITED_SOURCE_SHA]:
        return False
    prepare = records[_PREPARE]
    if (
        prepare[:7] != ["##[group]Run set -euo pipefail", *_PREPARE_COMMAND]
        or prepare.count("##[endgroup]") != 1
        or [line for line in prepare if line.startswith("  APPLY:")] != ["  APPLY: true"]
    ):
        return False
    return (
        prepare[prepare.index("##[endgroup]") + 1 :] == [_DIAGNOSTIC, _EXIT]
        and diagnostics == [(_PREPARE, _DIAGNOSTIC)]
        and errors == [(_PREPARE, _EXIT)]
    )


def qualify_guard_only_run(
    repository: str,
    environment: str,
    run: dict[str, Any],
    job: dict[str, Any],
    log: str,
    source_blobs: dict[str, str],
) -> dict[str, str | int] | None:
    """Return closed proof identifiers, or None when any evidence is uncertain."""
    if (
        environment != "uat"
        or not isinstance(repository, str)
        or re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is None
        or not isinstance(run, dict)
        or not isinstance(job, dict)
        or not isinstance(source_blobs, dict)
        or source_blobs != AUDITED_SOURCE_BLOBS
        or run.get("path") != ".github/workflows/capacity-maintenance.yml"
        or run.get("head_branch") != "main"
        or run.get("event") not in ("repository_dispatch", "workflow_dispatch")
        or run.get("head_sha") != AUDITED_SOURCE_SHA
        or job.get("head_sha") != AUDITED_SOURCE_SHA
        or run.get("status") != "completed"
        or run.get("conclusion") != "failure"
        or job.get("name") != _JOB
        or job.get("status") != "completed"
        or job.get("conclusion") != "failure"
        or any(
            type(value) is not int or value < 1
            for value in (run.get("id"), job.get("id"), run.get("run_attempt"))
        )
        or type(job.get("run_id")) is not int
        or job["run_id"] != run["id"]
        or type(job.get("run_attempt")) is not int
        or job["run_attempt"] != run["run_attempt"]
        # A later guard-only attempt cannot account for an earlier lost checkpoint.
        or run["run_attempt"] != 1
        or any(
            not isinstance(run.get(key), dict) or run[key].get("full_name") != repository
            for key in ("repository", "head_repository")
        )
        or not _steps_match(job)
        or not _log_matches(log)
    ):
        return None
    return {
        "schema": "retention_guard_only_failure.v1",
        "environment": "uat",
        "run_id": run["id"],
        "job_id": job["id"],
        "run_attempt": run["run_attempt"],
        "source_sha": AUDITED_SOURCE_SHA,
        "script_blob": AUDITED_SOURCE_BLOBS["scripts/ci/uat-retention-maintenance.py"],
        "workflow_blob": AUDITED_SOURCE_BLOBS[".github/workflows/capacity-maintenance.yml"],
    }
