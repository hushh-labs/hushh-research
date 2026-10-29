"""Source/job proof of cold-lease absence; grants no health or mutation authority."""

from __future__ import annotations

import hashlib
import re
from typing import Any

JOB_ID = "complete-restoration-activation"
ADMISSION_STEP = "Admit manual restoration verification only"
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


def skipped_primary_name(workflow: str) -> str | None:
    """GitHub reports an unevaluated name expression for a skipped job."""
    names = re.findall(r"^    name: (.+)$", _job_block(workflow, "deploy"), re.M)
    if len(names) != 1 or not names[0].startswith("${{") or not names[0].endswith("}}"):
        return None
    return names[0][3:-2].strip() or None


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
