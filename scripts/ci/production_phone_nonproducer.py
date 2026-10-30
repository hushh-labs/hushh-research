"""Source/job proof of cold-lease absence; grants no health or mutation authority."""

from __future__ import annotations

import hashlib
import re
from typing import Any

JOB_ID = "complete-restoration-activation"
ADMISSION_STEP = "Admit manual restoration verification only"
PRODUCTION_JOB_NAMES = {
    "deploy": "Deploy Production Scope",
    "complete-phone-activation": "Deploy Production Scope · Phone activation",
    JOB_ID: "Deploy Production Scope · Restoration activation",
}
LEGACY_PRODUCTION_JOB_EXPRESSIONS = {
    "deploy": "(inputs.phone_phase == 'activate' || inputs.restoration_activation_run_id != '') && 'Ordinary production deploy (not selected)' || 'Deploy Production Scope'",
    "complete-phone-activation": "inputs.phone_phase == 'activate' && inputs.restoration_activation_run_id == '' && 'Deploy Production Scope' || 'Activation continuation not selected'",
    JOB_ID: "inputs.restoration_activation_run_id != '' && 'Deploy Production Scope' || 'Restoration continuation not selected'",
}
LEGACY_PRIMARY_NAME = LEGACY_PRODUCTION_JOB_EXPRESSIONS["deploy"]
LEGACY_PRODUCTION_JOB_NAMES = frozenset(
    {
        "Deploy Production Scope",
        *LEGACY_PRODUCTION_JOB_EXPRESSIONS.values(),
    }
)
PRODUCTION_JOB_NAME_ALIASES = frozenset(
    {*PRODUCTION_JOB_NAMES.values(), *LEGACY_PRODUCTION_JOB_NAMES}
)
RESTORATION_ACTIVE_JOB_NAMES = frozenset(
    {PRODUCTION_JOB_NAMES[JOB_ID], "Deploy Production Scope"}
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


def skipped_primary_name(workflow: str) -> str | None:
    """GitHub reports an unevaluated name expression for a skipped job."""
    names = re.findall(r"^    name: (.+)$", _job_block(workflow, "deploy"), re.M)
    if len(names) != 1 or not names[0].startswith("${{") or not names[0].endswith("}}"):
        return None
    return names[0][3:-2].strip() or None


def production_job_name_aliases(workflow: str) -> frozenset[str]:
    """Return only the current labels or the exact legacy dynamic labels."""
    aliases: set[str] = set()
    for job_id, current in PRODUCTION_JOB_NAMES.items():
        names = re.findall(
            r"^    name: (.+)$", _job_block(workflow, job_id), re.M
        )
        _require(len(names) == 1, "production deployment job name is ambiguous")
        value = names[0]
        if value == current:
            aliases.add(current)
            continue
        expression = LEGACY_PRODUCTION_JOB_EXPRESSIONS[job_id]
        if value == "${{ " + expression + " }}":
            # Historically all three selected jobs evaluated to the same name;
            # skipped jobs could expose their raw expression through the API.
            aliases.add("Deploy Production Scope")
            aliases.add(expression)
            continue
        raise ValueError("production deployment job name is not a reviewed alias")
    primary = skipped_primary_name(workflow)
    _require(
        primary is None or primary == LEGACY_PRIMARY_NAME,
        "historical primary skip name is not a reviewed alias",
    )
    return frozenset(aliases)


def attempt_producer_job(jobs, run, attempt, workflow):
    """Select one producer job, allowing only proven empty skips as siblings."""
    try:
        aliases = production_job_name_aliases(workflow)
        skipped_name = skipped_primary_name(workflow)
    except ValueError as error:
        raise ValueError("production job source is ambiguous") from error
    _require(
        skipped_name is None or skipped_name in aliases,
        "historical primary skip name is not a reviewed alias",
    )
    matches = [job for job in jobs if job.get("name") in aliases]
    if not matches and attempt.get("status") in {
        "queued", "waiting", "requested", "pending"
    }:
        return None
    _require(bool(matches), "attempt production job is missing")
    _require(
        len({job.get("name") for job in matches}) == len(matches),
        "attempt production job name is duplicated",
    )
    bound = {
        "run_id": run["id"],
        "run_attempt": attempt["run_attempt"],
        "head_sha": run["head_sha"],
        "head_branch": "main",
    }
    for candidate in matches:
        _require(
            all(candidate.get(key) == value for key, value in bound.items()),
            "attempt production job is not bound",
        )
        steps = candidate.get("steps")
        _require(isinstance(steps, list), "attempt production job steps are invalid")
        if candidate.get("status") == "completed" and candidate.get("conclusion") == "skipped":
            _require(steps == [], "skipped production job contains executed steps")
    producers = [
        candidate
        for candidate in matches
        if not (
            candidate.get("status") == "completed"
            and candidate.get("conclusion") == "skipped"
            and candidate.get("steps") == []
        )
    ]
    _require(len(producers) <= 1, "production job producer is ambiguous")
    if producers:
        return producers[0]
    raw_skipped = [job for job in matches if job.get("name") == skipped_name]
    if skipped_name is None:
        return None
    _require(
        len(raw_skipped) == 1
        and raw_skipped[0].get("status") == "completed"
        and raw_skipped[0].get("conclusion") == "skipped"
        and raw_skipped[0].get("steps") == [],
        "historical skipped primary job is not uniquely unexecuted",
    )
    return raw_skipped[0]


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
