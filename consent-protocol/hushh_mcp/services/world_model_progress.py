"""Owner-safe progress derived from a sealed Personal World Model checkpoint.

The owner watches research run. What they see is counts, a stage, topic ids and
the public page titles the final report cites anyway. Nothing here carries an
identity value, an answer, a statement or a name: ``derive_progress`` reads only
the budget ledger (``attempted_combinations``, ``starts``), the attempt plans'
closed topic ids, the receipt table (title + url) and the assessment's closed
state, and it never raises on a partial or malformed checkpoint.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from hushh_mcp.one_adk.world_model import MAX_MODEL_CALLS, MAX_SEARCHES
from hushh_mcp.one_adk.world_model_contracts import TOPICS

IDENTITY_STATES = frozenset({"owner_linked", "candidate_for_review", "ambiguous", "no_match"})
MAX_TOPICS = 20
MAX_RECENT_SOURCES = 5
# Model calls charged after the last search before the run counts as composing
# the report: the search agent's own call plus two main-agent turns.
REPORT_CALLS_AFTER_SEARCH = 3
# Attempt keys that may carry an epoch timestamp once the runner records them.
ATTEMPT_TIME_KEYS = ("received_at", "finished_at", "started_at", "at")


def _iso(epoch: float | None) -> str | None:
    if type(epoch) not in {int, float} or epoch <= 0:
        return None
    return datetime.fromtimestamp(epoch, tz=UTC).isoformat().replace("+00:00", "Z")


def _epoch(value: Any) -> float | None:
    return float(value) if type(value) in {int, float} and value > 0 else None


def _stage(
    attempts: dict, assessment: dict, *, searches_used: int, calls_used: int, calls_after: int
) -> str:
    if not attempts:
        return "starting"
    identity = assessment.get("identity") if isinstance(assessment, dict) else None
    if not isinstance(identity, dict) or not identity.get("selected_candidate_id"):
        return "identity"
    if (
        searches_used >= MAX_SEARCHES
        or MAX_MODEL_CALLS - calls_used <= 2
        or calls_after >= REPORT_CALLS_AFTER_SEARCH
    ):
        return "report"
    return "coverage"


def derive_progress(state: dict, *, now: float, revision_at: float | None = None) -> dict:
    """Progress for the PwmProgress contract, from the sealed job state only.

    ``revision_at`` is when this process first saw the checkpoint's current
    revision; it stands in for the checkpoint's write time, which the store does
    not return. ``now`` bounds every timestamp so a clock skew never reports
    activity in the future.
    """
    work = state.get("work") if isinstance(state.get("work"), dict) else {}
    attempts = work.get("attempts") if isinstance(work.get("attempts"), dict) else {}
    sources = work.get("sources") if isinstance(work.get("sources"), dict) else {}
    assessment = work.get("assessment") if isinstance(work.get("assessment"), dict) else {}
    charged = [index for index in state.get("attempted_combinations") or [] if type(index) is int]
    searches_used = sum(1 for index in charged if 1 <= index <= MAX_SEARCHES)
    calls_used = len(charged) - searches_used
    last_search = max((i for i, index in enumerate(charged) if index <= MAX_SEARCHES), default=-1)
    calls_after = len(charged) - last_search - 1

    topics: list[str] = []
    for key in sorted(attempts, key=lambda value: int(value) if str(value).isdigit() else 0):
        plan = attempts[key].get("plan") if isinstance(attempts[key], dict) else None
        for topic in (plan or {}).get("topics") or []:
            if topic in TOPICS and topic not in topics:
                topics.append(topic)
    recent = []
    for row in list(sources.values())[-MAX_RECENT_SOURCES:]:
        title, url = (row or {}).get("title"), (row or {}).get("url")
        if isinstance(title, str) and isinstance(url, str) and url:
            recent.append({"title": title[:160] or "Source", "url": url})
    identity = assessment.get("identity") if isinstance(assessment.get("identity"), dict) else {}
    identity_state = identity.get("state")
    candidates = assessment.get("candidates")

    started_at = _epoch(state.get("started_at"))
    activity = [
        at for at in (started_at, revision_at, _epoch(state.get("updated_at"))) if at is not None
    ]
    for row in attempts.values():
        if isinstance(row, dict):
            activity.extend(
                at for key in ATTEMPT_TIME_KEYS if (at := _epoch(row.get(key))) is not None
            )
    last_activity = min(max(activity), now) if activity else None
    starts = state.get("starts") if isinstance(state.get("starts"), list) else []
    return {
        "stage": _stage(
            attempts,
            assessment,
            searches_used=searches_used,
            calls_used=calls_used,
            calls_after=calls_after,
        ),
        "searches_used": min(searches_used, MAX_SEARCHES),
        "searches_total": MAX_SEARCHES,
        "model_calls_used": min(calls_used, MAX_MODEL_CALLS),
        "model_calls_total": MAX_MODEL_CALLS,
        "topics_checked": topics[:MAX_TOPICS],
        "sources_found": len(sources),
        "recent_sources": recent,
        "identity_state": identity_state if identity_state in IDENTITY_STATES else None,
        "candidates": len(candidates) if isinstance(candidates, list) else 0,
        "started_at": _iso(started_at),
        "last_activity_at": _iso(last_activity),
        # The runner records the paid start before research begins, so the
        # ledger already counts the run in flight: a first run is part 1.
        "slice": max(1, len(starts)),
    }


__all__ = ["derive_progress"]
