"""Resumable selected-account Gmail scan with complete-section checkpoints."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from hushh_mcp.services.calendar_email_followup_account import (
    SelectedMailAccessError,
    open_selected_mail_grant,
)
from hushh_mcp.services.calendar_email_followup_coverage import (
    source_disposition,
)
from hushh_mcp.services.calendar_email_followup_extraction import (
    CompleteAssessment,
    ValidatedCandidate,
    ValidatedUpdate,
    assess_section,
    finalize_candidates,
)
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailMessage,
    CompleteMailReadError,
    profile_history_id,
    read_complete_message,
)
from hushh_mcp.services.calendar_email_followup_reconcile import reconcile_candidates
from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
    _clear_incomplete_message,
    _clear_message,
    _cutoff_ms,
    _initial_checkpoint,
    _mark_incomplete,
    _reset_exhausted,
    _save,
    _upgrade_checkpoint,
)
from hushh_mcp.services.calendar_email_followup_scan_navigation import _step_page, _step_thread
from hushh_mcp.services.calendar_email_followup_scan_source import (
    _CARRIED,
    _advance,
    _candidate,
    _dispose_source,
    _fail_message,
    _failure_result,
)
from hushh_mcp.services.calendar_email_followup_store import (
    CalendarEmailFollowupStore,
    FollowupStateError,
    Monitor,
)

logger = logging.getLogger(__name__)

Reconcile = Callable[..., Awaitable[tuple[ValidatedCandidate, ...]]]
_MODES = frozenset({"bootstrap", "history", "retry", "reassess"})


@dataclass(frozen=True)
class _MonitorFencedGrant:
    token: str
    grant: Any
    store: CalendarEmailFollowupStore
    monitor: Monitor

    async def require_current(self) -> None:
        await self.grant.require_current()
        await self.store.require_monitor_current(self.monitor)


async def _step(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    client: httpx.AsyncClient,
    sections_left: int,
    now: datetime | None,
    reconcile: Reconcile,
) -> tuple[int, int, bool]:
    """Advance one durable section, message, thread, or provider page boundary."""
    if checkpoint.get("version") != 1 or checkpoint.get("mode") not in _MODES:
        raise CompleteMailReadError("invalid_scan_checkpoint")
    common = {
        "monitor": monitor,
        "checkpoint": checkpoint,
        "store": store,
        "grant": grant,
        "client": client,
        "sections_left": sections_left,
        "now": now,
    }
    if checkpoint["thread_messages"]:
        return await _step_message(**common, reconcile=reconcile)
    if checkpoint["pending_threads"]:
        return await _step_thread(**common)
    return await _step_page(**common)


async def _step_message(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    client: httpx.AsyncClient,
    sections_left: int,
    now: datetime | None,
    reconcile: Reconcile,
) -> tuple[int, int, bool]:
    messages = checkpoint["thread_messages"]
    index = checkpoint["message_index"]
    if index >= len(messages):
        checkpoint["thread_messages"] = []
        checkpoint["message_index"] = 0
        checkpoint["thread_index"] += 1
        checkpoint["failed_this_thread"] = False
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    message_id = messages[index]
    thread_id = checkpoint["pending_threads"][checkpoint["thread_index"]]
    if checkpoint["section_index"] == 0:
        known = await store.scanned_state(monitor, message_id)
        if known is not None and known.current:
            # Already handled under the current contract: no fetch, no model call.
            _clear_incomplete_message(checkpoint, thread_id, message_id)
            await _advance(store, monitor, checkpoint)
            return 0, 0, False
    try:
        message = await read_complete_message(
            client=client,
            token=grant.token,
            message_id=message_id,
            require_current=grant.require_current,
        )
    except CompleteMailReadError as exc:
        await _dispose_source(
            monitor=monitor,
            checkpoint=checkpoint,
            store=store,
            exc=exc,
            message_id=message_id,
            thread_id=thread_id,
            internal_date_ms=0,
            now=now,
        )
        return 0, 0, False
    if message.internal_date_ms < _cutoff_ms(monitor, checkpoint) or (
        checkpoint["mode"] == "bootstrap" and message.internal_date_ms > checkpoint["snapshot_ms"]
    ):
        await _advance(store, monitor, checkpoint)
        return 0, 0, False
    if checkpoint["partial_body_digest"] not in {None, message.body_digest}:
        # The message changed under a half-finished assessment: start it over.
        _clear_message(checkpoint)
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    try:
        prior = await store.prior_requests(monitor, message.thread_id)
    except FollowupStateError as exc:
        if source_disposition(exc.code) != "retry":
            raise
        _mark_incomplete(checkpoint, message.thread_id, exc.code, now=now)
        checkpoint["thread_messages"] = []
        checkpoint["thread_index"] += 1
        checkpoint["message_index"] = 0
        checkpoint["failed_this_thread"] = False
        _clear_message(checkpoint)
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    consumed, moved_on = await _assess_sections(
        monitor=monitor,
        checkpoint=checkpoint,
        store=store,
        grant=grant,
        message=message,
        prior=prior,
        sections_left=sections_left,
        now=now,
    )
    if moved_on:
        return consumed, 0, False
    if checkpoint["section_index"] == len(message.sections):
        committed = await _commit_message_assessment(
            monitor=monitor,
            checkpoint=checkpoint,
            store=store,
            grant=grant,
            message=message,
            now=now,
            reconcile=reconcile,
        )
        return consumed, int(committed), False
    return consumed, 0, False


async def _assess_sections(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    message: CompleteMailMessage,
    prior: list[dict[str, str]],
    sections_left: int,
    now: datetime | None,
) -> tuple[int, bool]:
    consumed = 0
    while checkpoint["section_index"] < len(message.sections) and consumed < sections_left:
        section = message.sections[checkpoint["section_index"]]
        drops = dict(checkpoint["partial_drops"])
        try:
            found, changed = await assess_section(
                message=message,
                section=section,
                user_id=monitor.user_id,
                consent_token=f"calendar-email-followup:{monitor.generation}",
                owner_time_zone=monitor.time_zone,
                prior_requests=prior,
                evidence_key=store.cipher.evidence_key(monitor.user_id, monitor.account_id),
                require_current=grant.require_current,
                drops=drops,
            )
        except (SelectedMailAccessError, FollowupStateError):
            raise
        except CompleteMailReadError as exc:
            await _dispose_source(
                monitor=monitor,
                checkpoint=checkpoint,
                store=store,
                exc=exc,
                message_id=message.message_id,
                thread_id=message.thread_id,
                internal_date_ms=message.internal_date_ms,
                now=now,
            )
            return consumed, True
        except Exception:
            # The model failed or answered in a shape that did not validate.
            await _fail_message(
                monitor=monitor, checkpoint=checkpoint, store=store, message=message, now=now
            )
            return consumed, True
        checkpoint["partial_drops"] = drops
        checkpoint["partial_candidates"].extend(asdict(item) for item in found)
        checkpoint["partial_updates"].extend(asdict(item) for item in changed)
        checkpoint["partial_body_digest"] = message.body_digest
        checkpoint["section_index"] += 1
        consumed += 1
        await _save(store, monitor, checkpoint, "pending")
    return consumed, False


async def _commit_message_assessment(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    message: CompleteMailMessage,
    now: datetime | None,
    reconcile: Reconcile,
) -> bool:
    """Persist the message; False when it was set aside to retry instead."""
    if checkpoint["partial_body_digest"] != message.body_digest:
        raise CompleteMailReadError("incomplete_assessment")
    # Only a complete set of sections may become durable requests.
    drops = dict(checkpoint["partial_drops"])
    candidates = finalize_candidates(
        [_candidate(item) for item in checkpoint["partial_candidates"]], drops
    )
    try:
        candidates = await reconcile(
            monitor=monitor, subject=message.subject, candidates=candidates, drops=drops
        )
    except CompleteMailReadError as exc:
        await _dispose_source(
            monitor=monitor,
            checkpoint=checkpoint,
            store=store,
            exc=exc,
            message_id=message.message_id,
            thread_id=message.thread_id,
            internal_date_ms=message.internal_date_ms,
            now=now,
        )
        return False
    unique_updates = {
        (item["target_request_id"], item["outcome"], item["quote"]): ValidatedUpdate(**item)
        for item in checkpoint["partial_updates"]
    }
    known = await store.scanned_state(monitor, message.message_id)
    await grant.require_current()
    await store.commit_message(
        monitor,
        message,
        CompleteAssessment(
            expected_sections=len(message.sections),
            completed_sections=len(message.sections),
            candidates=tuple(candidates),
            updates=tuple(unique_updates.values()),
            dropped_counts=drops,
        ),
        now=now,
        # An earlier assessment exists but predates the current contract.
        reassess=known is not None and known.outcome == "assessed" and not known.current,
    )
    logger.info(
        "calendar_followup_message_assessed kept=%d dropped=%s",
        len(candidates),
        dict(sorted(drops.items())),
    )
    _clear_incomplete_message(checkpoint, message.thread_id, message.message_id)
    checkpoint["message_failures"].pop(message.message_id, None)
    await _advance(store, monitor, checkpoint)
    return True


async def _prepare(
    store: CalendarEmailFollowupStore,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    grant: Any,
    now: datetime | None,
    force: bool,
) -> dict[str, Any]:
    """The checkpoint this pass resumes: the saved one, or a fresh one.

    A first scan covers the owner's whole approved period. Recovering from
    expired history only needs the unsynchronized period, and keeps what was
    still unverified.
    """
    if force and checkpoint.get("mode") != "gap":
        _reset_exhausted(checkpoint)
    if checkpoint and checkpoint.get("mode") != "gap":
        return checkpoint
    recovering = checkpoint.get("mode") == "gap"
    carried = {key: checkpoint[key] for key in _CARRIED if key in checkpoint}
    history_id = await profile_history_id(
        client=client, token=grant.token, require_current=grant.require_current
    )
    resumed_from = (
        monitor.last_complete_at - timedelta(days=1)
        if recovering and monitor.last_complete_at
        else None
    )
    fresh = _initial_checkpoint(
        monitor,
        snapshot_ms=int((now or datetime.now(UTC)).timestamp() * 1000),
        history_id=history_id,
        cutoff_ms=int(resumed_from.timestamp() * 1000) if resumed_from else None,
    )
    fresh.update(carried)
    await _save(store, monitor, fresh, "pending")
    return fresh


async def _drain(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    client: httpx.AsyncClient,
    max_sections: int,
    now: datetime | None,
    reconcile: Reconcile,
    progress: dict[str, Any],
) -> None:
    """Take bounded steps until the budget is spent or the scan is complete."""
    for _ in range(12):
        used, completed, progress["done"] = await _step(
            monitor=monitor,
            checkpoint=checkpoint,
            store=store,
            grant=grant,
            client=client,
            sections_left=max_sections - progress["sections"],
            now=now,
            reconcile=reconcile,
        )
        progress["sections"] += used
        progress["messages"] += completed
        if progress["done"] or progress["sections"] >= max_sections:
            break


async def scan_once(
    *,
    user_id: str,
    account_id: str,
    store: CalendarEmailFollowupStore | None = None,
    now: datetime | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    max_sections: int = 2,
    force: bool = False,
    reconcile: Reconcile | None = None,
) -> dict[str, Any]:
    """Bound one drain while retaining every page, thread, and section cursor.

    ``force`` is the owner's manual Retry: it runs now and gives every source
    that exhausted its automatic attempts a fresh bounded allowance.
    """
    store = store or CalendarEmailFollowupStore()
    if not 1 <= max_sections <= 4:
        raise ValueError("invalid_scan_budget")
    monitor = await store.acquire_scan(
        user_id=user_id, account_id=account_id, **({"force": True} if force else {})
    )
    if not monitor:
        return {"state": "not_due", "sections": 0, "messages": 0}
    checkpoint = _upgrade_checkpoint(dict(monitor.checkpoint)) if monitor.checkpoint else {}
    progress: dict[str, Any] = {"sections": 0, "messages": 0, "done": False}
    try:
        selected = await open_selected_mail_grant(user_id=user_id, account_id=account_id)
        if selected.epoch_digest != monitor.grant_epoch_digest:
            raise SelectedMailAccessError("mail_grant_changed")
        grant = _MonitorFencedGrant(selected.token, selected, store, monitor)
        await grant.require_current()
        async with httpx.AsyncClient(
            transport=transport, timeout=10, follow_redirects=False
        ) as client:
            checkpoint = await _prepare(
                store, monitor, checkpoint, client=client, grant=grant, now=now, force=force
            )
            await _drain(
                monitor=monitor,
                checkpoint=checkpoint,
                store=store,
                grant=grant,
                client=client,
                max_sections=max_sections,
                now=now,
                reconcile=reconcile or reconcile_candidates,
                progress=progress,
            )
        state = (
            "partial"
            if checkpoint.get("incomplete_sources")
            else "complete"
            if progress["done"]
            else "pending"
        )
        return {"state": state, "sections": progress["sections"], "messages": progress["messages"]}
    except Exception as exc:
        return await _failure_result(store, monitor, checkpoint, exc, progress)
    finally:
        await store.release_scan(monitor)
