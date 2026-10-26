"""Qualify one reviewed historical checkpoint-guard failure, without authority.

The caller supplies the latest authenticated run/job, its bounded official job
log, and Git blob IDs resolved at AUDITED_SOURCE_SHA. This module performs no
I/O and never returns log text, credentials, a checkpoint, or mutation authority.
Unknown evidence remains a refusal; the ordinary checkpoint guard still owns
all other failures and the caller must continue checking older maintenance.
"""

from __future__ import annotations

import re
import json
from datetime import datetime, timedelta
from typing import Any

AUDITED_SOURCE_SHA = "f454c67bceefa9829c6825a65d907f8cdd4e6069"
AUDITED_SOURCE_SHAS = frozenset(
    {
        AUDITED_SOURCE_SHA,
        "2c720061b7a711ded7d3f822f67c72d73d98e6e2",
        "c738ff0b975d9a326664f9af356eea2dc7d90125",
    }
)
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
        conclusion = (
            "failure" if name == _PREPARE else "skipped" if name == _SAVE else "success"
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


def _log_matches(log: str, source_sha: str) -> bool:
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
    positions = [
        index for index, content in enumerate(checkout) if content == _CHECKOUT_COMMAND
    ]
    if len(positions) != 1 or checkout[positions[0] + 1 : positions[0] + 2] != [
        source_sha
    ]:
        return False
    prepare = records[_PREPARE]
    if (
        prepare[:7] != ["##[group]Run set -euo pipefail", *_PREPARE_COMMAND]
        or prepare.count("##[endgroup]") != 1
        or [line for line in prepare if line.startswith("  APPLY:")]
        != ["  APPLY: true"]
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
        or not isinstance(run.get("head_sha"), str)
        or run["head_sha"] not in AUDITED_SOURCE_SHAS
        or job.get("head_sha") != run.get("head_sha")
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
            not isinstance(run.get(key), dict)
            or run[key].get("full_name") != repository
            for key in ("repository", "head_repository")
        )
        or not _steps_match(job)
        or not _log_matches(log, run["head_sha"])
    ):
        return None
    return {
        "schema": "retention_guard_only_failure.v1",
        "environment": "uat",
        "run_id": run["id"],
        "job_id": job["id"],
        "run_attempt": run["run_attempt"],
        "source_sha": run["head_sha"],
        "script_blob": AUDITED_SOURCE_BLOBS["scripts/ci/uat-retention-maintenance.py"],
        "workflow_blob": AUDITED_SOURCE_BLOBS[
            ".github/workflows/capacity-maintenance.yml"
        ],
    }


# The same pure owner also qualifies complete raw job transcripts. Source profiles
# prove the checkpoint barrier; neither a newer retry nor elapsed time clears custody.
REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/capacity-maintenance.yml"
OWNER = "scripts/ci/uat-retention-maintenance.py"
LEGACY_BLOBS = {
    OWNER: (AUDITED_SOURCE_BLOBS[OWNER], 88790),
    WORKFLOW: (AUDITED_SOURCE_BLOBS[WORKFLOW], 13614),
}
SOURCE_PROFILES = {
    AUDITED_SOURCE_BLOBS[OWNER]: LEGACY_BLOBS,
    "34050aa25db19afe6004d97fdc76bda7de9c6471": {
        OWNER: ("34050aa25db19afe6004d97fdc76bda7de9c6471", 91390),
        WORKFLOW: LEGACY_BLOBS[WORKFLOW],
        "scripts/ci/retention_preflight_evidence.py": (
            "55e824a5aa41801dadbef3ec12236291394eb00b",
            7541,
        ),
    },
}
RUNNER_WARNING = "##[warning]Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: google-github-actions/auth@v2, google-github-actions/setup-gcloud@v2. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/"


def _stamp(value):
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp if stamp.utcoffset() is not None else None
    except (AttributeError, ValueError, TypeError):
        return None


def _raw_rows(log, job):
    if not isinstance(log, str) or not log:
        return None
    try:
        if len(log.encode("utf-8")) > MAX_LOG_BYTES:
            return None
    except UnicodeError:
        return None
    start, end = (_stamp(job.get(key)) for key in ("started_at", "completed_at"))
    rows = []
    forbidden = (
        "Unable to process file command",
        "Invalid format",
        "The operation was canceled",
        "The operation was cancelled",
        "checkpoint_ready=true",
    )
    for line in log.splitlines():
        stamp, separator, body = line.partition(" ")
        at = _stamp(stamp)
        if not (
            separator
            and at
            and start
            and end
            and start <= at <= end
            and (not rows or at >= rows[-1][0])
        ):
            return None
        body = _STYLE.sub("", body)
        if any(token in body for token in forbidden):
            return None
        rows.append((at, body))
    final = rows[-2:] if rows and rows[-1][1] == RUNNER_WARNING else rows[-1:]
    if not (
        rows
        and rows[0][1].startswith("Current runner version:")
        and final
        and final[0][1] == "Cleaning up orphan processes"
    ):
        return None
    return rows


def _step_rows(rows, step):
    start, end = (_stamp(step.get(key)) for key in ("started_at", "completed_at"))
    if start is None or end is None:
        return []
    # Actions metadata has second precision; actual transcript stamps have fractions.
    return [body for at, body in rows if start <= at <= end + timedelta(seconds=1)]


def actual_checkout(log, job):
    """Extract only a complete finalized transcript's exact checkout command result."""
    rows = _raw_rows(log, job)
    if rows is None or not _steps_match(job):
        return None
    checkout = _step_rows(rows, job["steps"][1])
    commands = [i for i, body in enumerate(checkout) if body == _CHECKOUT_COMMAND]
    if len(commands) != 1 or commands[0] + 1 >= len(checkout):
        return None
    sha = checkout[commands[0] + 1]
    return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None


def _raw_failure(rows, job, profile):
    prepare = _step_rows(rows, job["steps"][6])
    commands = ["##[group]Run set -euo pipefail", *_PREPARE_COMMAND]
    positions = [i for i in range(len(prepare)) if prepare[i : i + 7] == commands]
    if len(positions) != 1 or prepare.count("  APPLY: true") != 1:
        return False
    grouped = prepare[positions[0] :]
    if "##[endgroup]" not in grouped:
        return False
    tail = grouped[grouped.index("##[endgroup]") + 1 :]
    reasons = {_DIAGNOSTIC}
    if profile == AUDITED_SOURCE_BLOBS[OWNER]:
        reasons.add("Hosted maintenance stopped: Drive worker is not ready")
    diagnostics = [
        body for _, body in rows if body.startswith("Hosted maintenance stopped:")
    ]
    errors = [body for _, body in rows if "##[error]" in body]
    terminal = len(tail) >= 2 and tail[0] in reasons and tail[1] == _EXIT
    if profile == "34050aa25db19afe6004d97fdc76bda7de9c6471" and _EXIT in tail:
        before_exit = tail[: tail.index(_EXIT)]
        # Frozen stdout may flush its one observer record after stderr's failure.
        terminal = (
            1 <= len(before_exit) <= 2
            and before_exit.count(_DIAGNOSTIC) == 1
            and all(
                body == _DIAGNOSTIC or _observer_record(body) for body in before_exit
            )
        )
    return (
        terminal
        and len(diagnostics) == 1
        and diagnostics[0] in reasons
        and errors == [_EXIT]
    )


def _observer_record(body):
    """Recognize frozen diagnostic output only; it grants no reconciliation authority."""
    try:
        value = json.loads(body)
    except (TypeError, ValueError):
        return False
    if not isinstance(value, dict) or set(value) != {"guard_only_reconciliation"}:
        return False
    proof = value["guard_only_reconciliation"]
    return (
        isinstance(proof, dict)
        and set(proof)
        == {
            "schema",
            "environment",
            "run_id",
            "job_id",
            "run_attempt",
            "source_sha",
            "script_blob",
            "workflow_blob",
        }
        and proof["schema"] == "retention_guard_only_failure.v1"
        and proof["environment"] == "uat"
        and all(
            type(proof[key]) is int and proof[key] > 0 for key in ("run_id", "job_id")
        )
        and type(proof["run_attempt"]) is int
        and proof["run_attempt"] == 1
        and proof["source_sha"] == "c738ff0b975d9a326664f9af356eea2dc7d90125"
        and proof["script_blob"] == AUDITED_SOURCE_BLOBS[OWNER]
        and proof["workflow_blob"] == AUDITED_SOURCE_BLOBS[WORKFLOW]
    )


def _source_profile(blobs, workflow_blob):
    for digest, profile in SOURCE_PROFILES.items():
        expected = {
            path: {"sha": sha, "size": size} for path, (sha, size) in profile.items()
        }
        if blobs == expected and workflow_blob == expected[WORKFLOW]:
            return digest
    return None


def qualify_preflight_run(
    repository, environment, run, job, log, source_blobs, workflow_blob
):
    """One exact completed attempt may prove no mutation; it never resolves older custody."""
    if not isinstance(run, dict) or not isinstance(job, dict):
        return None
    if not (
        repository == REPOSITORY
        and environment == "uat"
        and run.get("status") == "completed"
        and run.get("conclusion") == "failure"
        and run.get("path") == WORKFLOW
        and run.get("head_branch") == "main"
        and run.get("event") in {"schedule", "workflow_dispatch", "repository_dispatch"}
        and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        and all(
            type(value) is int and value > 0
            for value in (run.get("id"), run.get("run_attempt"), job.get("id"))
        )
        and run["run_attempt"] <= 10
        and all(
            (run.get(key) or {}).get("full_name") == repository
            for key in ("repository", "head_repository")
        )
        and job.get("name") == _JOB
        and job.get("status") == "completed"
        and job.get("conclusion") == "failure"
        and job.get("head_branch") == "main"
        and job.get("run_id") == run["id"]
        and type(job.get("run_attempt")) is int
        and job.get("run_attempt") == run["run_attempt"]
        and job.get("head_sha") == run["head_sha"]
        and _steps_match(job)
    ):
        return None
    rows, checkout = _raw_rows(log, job), actual_checkout(log, job)
    profile = _source_profile(source_blobs, workflow_blob)
    if (
        rows is None
        or checkout is None
        or profile is None
        or not _raw_failure(rows, job, profile)
    ):
        return None
    return {
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "job_id": job["id"],
        "checkout_sha": checkout,
        "qualification": "no_provider_mutation",
    }
