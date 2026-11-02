"""Per-message outcomes and early-exit reporting for the selected-account scan.

A message that cannot be read, a message the model keeps failing on and a pass
that ends early each have exactly one meaning here, so the scan loop itself only
decides what to read next.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from hushh_mcp.services.calendar_email_followup_account import SelectedMailAccessError
from hushh_mcp.services.calendar_email_followup_coverage import (
    MAX_MESSAGE_FAILURES,
    source_disposition,
)
from hushh_mcp.services.calendar_email_followup_extraction import ValidatedCandidate
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailMessage,
    CompleteMailReadError,
)
from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
    _clear_incomplete_message,
    _clear_message,
    _mark_incomplete,
    _record_unreadable,
    _save,
)
from hushh_mcp.services.calendar_email_followup_store import (
    CalendarEmailFollowupStore,
    FollowupStateError,
    Monitor,
)

# State a gap recovery must not forget: what is still unverified stays unverified.
_CARRIED = ("incomplete_sources", "unreadable", "message_failures", "reassess_seen")


def _candidate(item: dict[str, Any]) -> ValidatedCandidate:
    """Rebuild a candidate sealed in a checkpoint, tolerating older shapes."""
    linked = item.get("linked_event")
    return ValidatedCandidate(
        **{
            **item,
            "ambiguities": tuple(item.get("ambiguities") or ()),
            "linked_event": tuple(linked) if linked else None,
        }
    )


async def _advance(
    store: CalendarEmailFollowupStore, monitor: Monitor, checkpoint: dict[str, Any]
) -> None:
    """Finish with the current message, whatever its outcome, and persist."""
    checkpoint["message_index"] += 1
    _clear_message(checkpoint)
    await _save(store, monitor, checkpoint, "pending")


async def _dispose_source(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    exc: CompleteMailReadError,
    message_id: str,
    thread_id: str,
    internal_date_ms: int,
    now: datetime | None,
) -> None:
    """Decide what a message-level failure means, then move past the message.

    Retrying a message that cannot be read only wastes calls and would show an
    unfixable warning, so it is recorded and counted. A deleted message is
    retired. Anything plausibly transient is rescheduled with bounded backoff.
    Everything else is a provider-wide or owner problem and ends the pass.
    """
    disposition = source_disposition(exc.code)
    if disposition == "raise":
        raise exc
    if disposition == "unreadable":
        await store.record_message_outcome(
            monitor,
            message_id=message_id,
            thread_id=thread_id,
            internal_date_ms=internal_date_ms,
            outcome="unreadable",
        )
        _record_unreadable(checkpoint)
        _clear_incomplete_message(checkpoint, thread_id, message_id)
    elif disposition == "gone":
        await store.mark_messages_gone(monitor, [(message_id, thread_id)])
        _clear_incomplete_message(checkpoint, thread_id, message_id)
    else:
        _mark_incomplete(
            checkpoint,
            thread_id,
            exc.code,
            message_id,
            now=now,
            retry_after=exc.retry_after,
        )
    await _advance(store, monitor, checkpoint)


async def _fail_message(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    message: CompleteMailMessage,
    now: datetime | None,
) -> None:
    """Count a model or validation failure against this message.

    The first failures are treated as a transient model problem: the whole pass
    backs off and this message is tried again. A message that keeps failing is
    set aside as a recoverable source, so one poisonous email cannot stall every
    email behind it, and it stays visible as unverified until it succeeds.
    """
    failures = checkpoint.setdefault("message_failures", {})
    count = int(failures.get(message.message_id, 0)) + 1
    if count < MAX_MESSAGE_FAILURES:
        failures[message.message_id] = count
        raise CompleteMailReadError("analysis_unavailable", retryable=True)
    failures.pop(message.message_id, None)
    _mark_incomplete(
        checkpoint, message.thread_id, "assessment_failed", message.message_id, now=now
    )
    await _advance(store, monitor, checkpoint)


def _gap_checkpoint(checkpoint: dict[str, Any]) -> dict[str, Any]:
    """Restart from the provider's current state without forgetting open gaps."""
    gap: dict[str, Any] = {"version": 1, "mode": "gap"}
    gap.update({key: checkpoint[key] for key in _CARRIED if key in checkpoint})
    return gap


async def _failure_result(
    store: CalendarEmailFollowupStore,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    exc: Exception,
    progress: dict[str, Any],
) -> dict[str, Any]:
    """Save what a pass that ended early can, and report why in value-free terms."""
    known = isinstance(exc, CompleteMailReadError | SelectedMailAccessError | FollowupStateError)
    code = exc.code if known else "analysis_unavailable"  # type: ignore[attr-defined]
    report = {"reason": code, "sections": progress["sections"], "messages": progress["messages"]}
    if code == "monitor_changed":
        # Consent or schedule changed under this pass; the next one starts clean.
        return {"state": "partial", **report}
    try:
        if code == "history_gap":
            # Expired history is a recovery step, not a failure: restart from the
            # provider's current state and count nothing against the owner.
            await store.save_checkpoint(monitor, _gap_checkpoint(checkpoint), state="pending")
        else:
            await store.save_checkpoint(
                monitor,
                checkpoint,
                state="partial",
                error_code=code,
                retry_in=getattr(exc, "retry_after", None),
            )
    except FollowupStateError:
        pass
    return {"state": "pending" if code == "history_gap" else "partial", **report}
