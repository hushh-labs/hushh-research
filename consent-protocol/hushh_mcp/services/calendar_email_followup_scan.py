"""Resumable selected-account Gmail scan with complete-section checkpoints."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from hushh_mcp.services.calendar_email_followup_account import (
    SelectedMailAccessError,
    open_selected_mail_grant,
)
from hushh_mcp.services.calendar_email_followup_extraction import (
    CompleteAssessment,
    ValidatedCandidate,
    ValidatedUpdate,
    assess_section,
)
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailMessage,
    CompleteMailReadError,
    profile_history_id,
    read_complete_message,
)
from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
    _SOURCE_INCOMPLETE,
    _clear_incomplete_message,
    _clear_message,
    _initial_checkpoint,
    _mark_incomplete,
    _save,
)
from hushh_mcp.services.calendar_email_followup_scan_navigation import _step_page, _step_thread
from hushh_mcp.services.calendar_email_followup_store import (
    CalendarEmailFollowupStore,
    FollowupStateError,
    Monitor,
)


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
) -> tuple[int, int, bool]:
    """Advance one durable section, message, thread, or provider page boundary."""
    if checkpoint.get("version") != 1 or checkpoint.get("mode") not in {
        "bootstrap",
        "history",
        "retry",
    }:
        raise CompleteMailReadError("invalid_scan_checkpoint")
    if checkpoint["thread_messages"]:
        return await _step_message(
            monitor=monitor,
            checkpoint=checkpoint,
            store=store,
            grant=grant,
            client=client,
            sections_left=sections_left,
            now=now,
        )
    if checkpoint["pending_threads"]:
        return await _step_thread(
            monitor=monitor,
            checkpoint=checkpoint,
            store=store,
            grant=grant,
            client=client,
            sections_left=sections_left,
            now=now,
        )
    return await _step_page(
        monitor=monitor,
        checkpoint=checkpoint,
        store=store,
        grant=grant,
        client=client,
        sections_left=sections_left,
        now=now,
    )


async def _step_message(
    *,
    monitor: Monitor,
    checkpoint: dict[str, Any],
    store: CalendarEmailFollowupStore,
    grant: Any,
    client: httpx.AsyncClient,
    sections_left: int,
    now: datetime | None,
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
    try:
        message = await read_complete_message(
            client=client,
            token=grant.token,
            message_id=message_id,
            require_current=grant.require_current,
        )
    except CompleteMailReadError as exc:
        if exc.code not in _SOURCE_INCOMPLETE:
            raise
        _mark_incomplete(
            checkpoint,
            checkpoint["pending_threads"][checkpoint["thread_index"]],
            exc.code,
            message_id,
        )
        checkpoint["message_index"] += 1
        _clear_message(checkpoint)
        await _save(store, monitor, checkpoint, "partial")
        return 0, 0, False
    cutoff = checkpoint["cutoff_ms"]
    snapshot = checkpoint["snapshot_ms"]
    if message.internal_date_ms < cutoff or (
        checkpoint["mode"] == "bootstrap" and message.internal_date_ms > snapshot
    ):
        checkpoint["message_index"] += 1
        _clear_message(checkpoint)
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    if (
        checkpoint["section_index"] == 0
        and await store.scanned_digest(monitor, message_id) == message.body_digest
    ):
        _clear_incomplete_message(checkpoint, message.thread_id, message_id)
        checkpoint["message_index"] += 1
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False
    if checkpoint["partial_body_digest"] not in {None, message.body_digest}:
        _clear_message(checkpoint)
        await _save(store, monitor, checkpoint, "partial")
        return 0, 0, False
    try:
        prior = await store.prior_requests(monitor, message.thread_id)
    except FollowupStateError as exc:
        if exc.code != "incomplete_thread_context":
            raise
        _mark_incomplete(checkpoint, message.thread_id, exc.code)
        checkpoint["thread_messages"] = []
        checkpoint["thread_index"] += 1
        checkpoint["message_index"] = 0
        checkpoint["failed_this_thread"] = False
        _clear_message(checkpoint)
        await _save(store, monitor, checkpoint, "partial")
        return 0, 0, False
    consumed, failed = await _assess_sections(
        monitor=monitor,
        checkpoint=checkpoint,
        store=store,
        grant=grant,
        message=message,
        prior=prior,
        sections_left=sections_left,
    )
    if failed:
        return consumed, 0, False
    if checkpoint["section_index"] == len(message.sections):
        await _commit_message_assessment(
            monitor=monitor,
            checkpoint=checkpoint,
            store=store,
            grant=grant,
            message=message,
            now=now,
        )
        return consumed, 1, False
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
) -> tuple[int, bool]:
    consumed = 0
    while checkpoint["section_index"] < len(message.sections) and consumed < sections_left:
        section = message.sections[checkpoint["section_index"]]
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
            )
        except CompleteMailReadError as exc:
            if exc.code not in _SOURCE_INCOMPLETE:
                raise
            _mark_incomplete(checkpoint, message.thread_id, exc.code, message.message_id)
            checkpoint["message_index"] += 1
            _clear_message(checkpoint)
            await _save(store, monitor, checkpoint, "partial")
            return consumed, True
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
) -> None:
    if checkpoint["partial_body_digest"] != message.body_digest:
        raise CompleteMailReadError("incomplete_assessment")
    # Only a complete set of sections may become durable requests.
    unique_candidates: dict[str, ValidatedCandidate] = {}
    for item in checkpoint["partial_candidates"]:
        candidate = ValidatedCandidate(**item)
        existing = unique_candidates.get(candidate.evidence_key)
        if existing is not None and existing != candidate:
            raise FollowupStateError("ambiguous_overlapping_evidence")
        unique_candidates[candidate.evidence_key] = candidate
    unique_updates = {
        (item["target_request_id"], item["outcome"], item["quote"]): ValidatedUpdate(**item)
        for item in checkpoint["partial_updates"]
    }
    await grant.require_current()
    await store.commit_message(
        monitor,
        message,
        CompleteAssessment(
            expected_sections=len(message.sections),
            completed_sections=len(message.sections),
            candidates=tuple(unique_candidates.values()),
            updates=tuple(unique_updates.values()),
        ),
        now=now,
    )
    _clear_incomplete_message(checkpoint, message.thread_id, message.message_id)
    checkpoint["message_index"] += 1
    _clear_message(checkpoint)
    await _save(store, monitor, checkpoint, "pending")


async def scan_once(
    *,
    user_id: str,
    account_id: str,
    store: CalendarEmailFollowupStore | None = None,
    now: datetime | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    max_sections: int = 2,
) -> dict[str, Any]:
    """Bound one drain while retaining every page, thread, and section cursor."""
    store = store or CalendarEmailFollowupStore()
    if not 1 <= max_sections <= 4:
        raise ValueError("invalid_scan_budget")
    monitor = await store.acquire_scan(user_id=user_id, account_id=account_id)
    if not monitor:
        return {"state": "not_due", "sections": 0, "messages": 0}
    checkpoint = dict(monitor.checkpoint or {})
    sections_done = messages_done = 0
    try:
        selected = await open_selected_mail_grant(user_id=user_id, account_id=account_id)
        if selected.epoch_digest != monitor.grant_epoch_digest:
            raise SelectedMailAccessError("mail_grant_changed")
        grant = _MonitorFencedGrant(selected.token, selected, store, monitor)
        await grant.require_current()
        async with httpx.AsyncClient(
            transport=transport, timeout=10, follow_redirects=False
        ) as client:
            if not checkpoint or checkpoint.get("mode") == "gap":
                history_id = await profile_history_id(
                    client=client, token=grant.token, require_current=grant.require_current
                )
                snapshot_ms = int((now or datetime.now(UTC)).timestamp() * 1000)
                checkpoint = _initial_checkpoint(
                    monitor, snapshot_ms=snapshot_ms, history_id=history_id
                )
                await _save(store, monitor, checkpoint, "pending")
            for _ in range(12):
                used, completed, done = await _step(
                    monitor=monitor,
                    checkpoint=checkpoint,
                    store=store,
                    grant=grant,
                    client=client,
                    sections_left=max_sections - sections_done,
                    now=now,
                )
                sections_done += used
                messages_done += completed
                if done or sections_done >= max_sections:
                    break
        return {
            "state": "partial"
            if checkpoint.get("incomplete_sources")
            else "complete"
            if done
            else "pending",
            "sections": sections_done,
            "messages": messages_done,
        }
    except (CompleteMailReadError, SelectedMailAccessError, FollowupStateError) as exc:
        code = exc.code
        if code == "history_gap":
            checkpoint = {"version": 1, "mode": "gap"}
        try:
            await store.save_checkpoint(monitor, checkpoint, state="partial", error_code=code)
        except FollowupStateError:
            pass
        return {
            "state": "partial",
            "reason": code,
            "sections": sections_done,
            "messages": messages_done,
        }
    except Exception:
        try:
            await store.save_checkpoint(
                monitor, checkpoint, state="partial", error_code="analysis_unavailable"
            )
        except FollowupStateError:
            pass
        return {
            "state": "partial",
            "reason": "analysis_unavailable",
            "sections": sections_done,
            "messages": messages_done,
        }
    finally:
        await store.release_scan(monitor)
