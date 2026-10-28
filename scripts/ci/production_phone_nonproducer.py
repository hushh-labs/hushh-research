"""Source/job proof of cold-lease absence; grants no health or mutation authority."""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any

JOB_ID = "complete-restoration-activation"
ADMISSION_STEP = "Admit manual restoration verification only"
STAGE_JOB = "Stage qualified production Drive worker"
# Reviewed workflow at 6b8ec6c63e, which has exactly these four jobs and no
# cold-health-tag producer in its worker-stage job. New source needs review.
STAGE_SOURCE_SHA256 = "918e1c4ea02b46244b9db211995bd2c3182af8365a252afcc8740e38869c22e3"
STAGE_SKIPPED_JOBS = frozenset(
    {
        "(inputs.phone_phase == 'activate' || inputs.restoration_activation_run_id != '') && 'Ordinary production deploy (not selected)' || 'Deploy Production Scope'",
        "inputs.phone_phase == 'activate' && inputs.restoration_activation_run_id == '' && 'Deploy Production Scope' || 'Activation continuation not selected'",
        "inputs.restoration_activation_run_id != '' && 'Deploy Production Scope' || 'Restoration continuation not selected'",
    }
)
_MUTATORS = (
    "builds submit",
    "gcloud run deploy",
    "cold_fallback.py",
    "backend-phone-rollback.sh",
)
# Reviewed restoration job from 0c32dc1cba0e5a0a4d7a3f9c257baf32e2e4b14b,
# used by healthy run 40475676949/2 before two additive dispatch gates.
# This recognizes only its exact nonproducer source; it grants no health authority.
_REVIEWED_RESTORATION_BLOCKS = frozenset(
    {"94db30af3be1742efd4f2105f43aa2508d74fbceb58a2d3cc26c92795ea24d62"}
)


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def recognizes(job: dict[str, Any]) -> bool:
    steps = job.get("steps")
    return (
        isinstance(steps, list)
        and all(
            isinstance(step, dict) and isinstance(step.get("name"), str)
            for step in steps
        )
        and any(step["name"] == ADMISSION_STEP for step in steps)
    )


def _job_block(text: str, name: str) -> str:
    blocks = re.findall(
        rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", text
    )
    _require(len(blocks) == 1, "restoration workflow job is ambiguous")
    return blocks[0]


def _source(workflow: str, canonical: str, lease_markers: tuple[str, ...]) -> None:
    # Every other changed historical job shape still requires compatibility review.
    block = _job_block(workflow, JOB_ID)
    _require(
        (
            block == _job_block(canonical, JOB_ID)
            or hashlib.sha256(block.encode()).hexdigest()
            in _REVIEWED_RESTORATION_BLOCKS
        )
        and not any(marker in block for marker in (*lease_markers, *_MUTATORS)),
        "restoration source or cold-producer absence is unproved",
    )
    for name in ("deploy", "stage-drive-worker", "complete-phone-activation"):
        expected = re.findall(r"^    if: (.+)$", _job_block(canonical, name), re.M)
        _require(
            len(expected) == 1
            and expected[0].endswith("&& inputs.restoration_activation_run_id == ''")
            and re.findall(r"^    if: (.+)$", _job_block(workflow, name), re.M)
            == expected,
            "restoration producer exclusion is unproved",
        )


def qualify(
    job: dict[str, Any],
    attempt: dict[str, Any],
    workflow: str,
    canonical: str,
    *,
    current: bool,
    lease_markers: tuple[str, ...],
    guard: str,
) -> None:
    """Prove only nonproduction, including terminal failed/cancelled attempts."""
    _require(recognizes(job), "restoration job shape is unproved")
    _source(workflow, canonical, lease_markers)
    steps = job["steps"]
    indexed = {step["name"]: step for step in steps}
    _require(
        len(indexed) == len(steps)
        and not any(
            marker in step["name"] for marker in lease_markers for step in steps
        ),
        "restoration producer absence is unproved",
    )
    if current:
        _require(
            indexed[ADMISSION_STEP].get("status") == "completed"
            and indexed[ADMISSION_STEP].get("conclusion") == "success"
            and indexed.get(guard, {}).get("status") == "in_progress"
            and indexed[guard].get("conclusion") is None
            and sum(step.get("status") == "in_progress" for step in steps) == 1,
            "restoration is not at its exact active guard",
        )
        return
    _require(
        attempt.get("status") == job.get("status") == "completed"
        and attempt.get("conclusion") == job.get("conclusion")
        and job.get("conclusion") in {"success", "failure", "cancelled"}
        and all(
            step.get("status") == "completed"
            and step.get("conclusion") in {"success", "failure", "cancelled", "skipped"}
            for step in steps
        ),
        "restoration nonproducer is not terminal",
    )


def qualify_worker_only(repository, attempt, result, text, trusted, *, guard):
    """Recognize one reviewed worker-only shape; never establish release health."""
    _require(
        trusted
        and hashlib.sha256(text.encode("utf-8")).hexdigest() == STAGE_SOURCE_SHA256,
        "worker-only source is not reviewed",
    )
    jobs = result["jobs"]
    by_name = {job.get("name"): job for job in jobs}
    _require(
        len(jobs) == len(by_name) == 4
        and set(by_name) == STAGE_SKIPPED_JOBS | {STAGE_JOB}
        and all(
            all(
                job.get(key) == value
                for key, value in {
                    "run_id": attempt["id"],
                    "run_attempt": attempt["run_attempt"],
                    "head_sha": attempt["head_sha"],
                    "head_branch": "main",
                }.items()
            )
            for job in jobs
        ),
        "worker-only attempt inventory is not bound",
    )
    _require(
        all(
            by_name[name].get("status") == "completed"
            and by_name[name].get("conclusion") == "skipped"
            and by_name[name].get("runner_name") is None
            and by_name[name].get("steps") == []
            for name in STAGE_SKIPPED_JOBS
        ),
        "worker-only producer exclusion is unproved",
    )
    stage = by_name[STAGE_JOB]
    steps = stage.get("steps")
    _require(
        isinstance(steps, list)
        and 0 < len(steps) <= 500
        and all(
            isinstance(step, dict) and isinstance(step.get("name"), str)
            for step in steps
        )
        and len({step["name"] for step in steps}) == len(steps),
        "worker-only steps are invalid",
    )
    current = attempt.get("status") == stage.get("status") == "in_progress" and all(
        os.environ.get(key) == value
        for key, value in {
            "GITHUB_JOB": "stage-drive-worker",
            "GITHUB_RUN_ID": str(attempt["id"]),
            "GITHUB_RUN_ATTEMPT": str(attempt["run_attempt"]),
            "GITHUB_REPOSITORY": repository,
            "GITHUB_REF_NAME": "main",
            "GITHUB_SHA": attempt["head_sha"],
        }.items()
    )
    if current:
        guard = [step for step in steps if step["name"] == guard]
        _require(
            len(guard) == 1
            and guard[0].get("status") == "in_progress"
            and guard[0].get("conclusion") is None
            and sum(step.get("status") == "in_progress" for step in steps) == 1,
            "worker-only current guard is not bound",
        )
        return
    _require(
        attempt.get("status") == stage.get("status") == "completed"
        and attempt.get("conclusion") == stage.get("conclusion")
        and stage.get("conclusion") in {"success", "failure", "cancelled"}
        and all(
            step.get("status") == "completed"
            and step.get("conclusion") in {"success", "failure", "cancelled", "skipped"}
            for step in steps
        ),
        "worker-only attempt is not terminal",
    )
