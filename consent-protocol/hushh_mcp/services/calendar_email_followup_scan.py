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
    CompleteMailReadError,
    history_message_page,
    list_message_page,
    profile_history_id,
    read_complete_message,
    thread_message_ids,
)
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


def _initial_checkpoint(monitor: Monitor, *, snapshot_ms: int, history_id: str) -> dict[str, Any]:
    return {
        "version": 1,
        "mode": "bootstrap",
        "cutoff_ms": int(monitor.historical_start_at.timestamp() * 1000),
        "snapshot_ms": snapshot_ms,
        "history_id": history_id,
        "page_token": None,
        "next_page_token": None,
        "pending_threads": [],
        "thread_index": 0,
        "thread_messages": [],
        "message_index": 0,
        "section_index": 0,
        "partial_candidates": [],
        "partial_updates": [],
        "partial_body_digest": None,
        "incomplete_sources": {},
        "failed_this_thread": False,
        "retry_cursor": 0,
    }


def _clear_message(checkpoint: dict[str, Any]) -> None:
    checkpoint["section_index"] = 0
    checkpoint["partial_candidates"] = []
    checkpoint["partial_updates"] = []
    checkpoint["partial_body_digest"] = None


_SOURCE_INCOMPLETE = frozenset(
    {
        "source_unavailable",
        "no_readable_body",
        "incomplete_body",
        "body_too_large",
        "provider_response_too_large",
        "unsupported_readable_part",
        "invalid_body_tree",
        "incomplete_thread",
        "assessment_overflow",
        "external_parts_limit",
    }
)


def _mark_incomplete(
    checkpoint: dict[str, Any], thread_id: str, code: str, message_id: str | None = None
) -> None:
    thread = checkpoint.setdefault("incomplete_sources", {}).setdefault(
        thread_id, {"thread": None, "messages": {}}
    )
    if message_id:
        thread["messages"][message_id] = code
    else:
        thread["thread"] = code
    checkpoint["failed_this_thread"] = True


def _clear_incomplete_message(checkpoint: dict[str, Any], thread_id: str, message_id: str) -> None:
    sources = checkpoint.setdefault("incomplete_sources", {})
    thread = sources.get(thread_id)
    if thread:
        thread["messages"].pop(message_id, None)
        if not thread["thread"] and not thread["messages"]:
            sources.pop(thread_id, None)


def _next_retry_batch(checkpoint: dict[str, Any]) -> list[str]:
    threads = list(checkpoint.get("incomplete_sources", {}))
    if not threads:
        return []
    start = int(checkpoint.get("retry_cursor", 0)) % len(threads)
    batch = [threads[(start + offset) % len(threads)] for offset in range(min(2, len(threads)))]
    checkpoint["retry_cursor"] = (start + len(batch)) % len(threads)
    return batch


async def _save(
    store: CalendarEmailFollowupStore, monitor: Monitor, checkpoint: dict[str, Any], state: str
) -> None:
    await store.save_checkpoint(monitor, checkpoint, state=state)  # type: ignore[arg-type]


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
    """Advance one durable boundary: section, message, thread, or provider page."""
    if checkpoint.get("version") != 1 or checkpoint.get("mode") not in {
        "bootstrap",
        "history",
        "retry",
    }:
        raise CompleteMailReadError("invalid_scan_checkpoint")
    messages = checkpoint["thread_messages"]
    if messages:
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
                _mark_incomplete(checkpoint, message.thread_id, exc.code, message_id)
                checkpoint["message_index"] += 1
                _clear_message(checkpoint)
                await _save(store, monitor, checkpoint, "partial")
                return consumed, 0, False
            checkpoint["partial_candidates"].extend(asdict(item) for item in found)
            checkpoint["partial_updates"].extend(asdict(item) for item in changed)
            checkpoint["partial_body_digest"] = message.body_digest
            checkpoint["section_index"] += 1
            consumed += 1
            await _save(store, monitor, checkpoint, "pending")
        if checkpoint["section_index"] == len(message.sections):
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
            _clear_incomplete_message(checkpoint, message.thread_id, message_id)
            checkpoint["message_index"] += 1
            _clear_message(checkpoint)
            await _save(store, monitor, checkpoint, "pending")
            return consumed, 1, False
        return consumed, 0, False

    threads = checkpoint["pending_threads"]
    if threads:
        index = checkpoint["thread_index"]
        if index >= len(threads):
            checkpoint["pending_threads"] = []
            checkpoint["thread_index"] = 0
            checkpoint["page_token"] = checkpoint["next_page_token"]
            checkpoint["next_page_token"] = None
            if checkpoint["page_token"] is None:
                if checkpoint["mode"] == "bootstrap":
                    checkpoint["mode"] = "history"
                elif checkpoint["mode"] == "retry":
                    checkpoint["mode"] = "history"
                    await _save(
                        store,
                        monitor,
                        checkpoint,
                        "partial" if checkpoint.get("incomplete_sources") else "complete",
                    )
                    return 0, 0, True
                else:
                    checkpoint["history_id"] = checkpoint["history_current_id"]
                    if checkpoint.get("incomplete_sources"):
                        checkpoint["mode"] = "retry"
                        checkpoint["pending_threads"] = _next_retry_batch(checkpoint)
                    await _save(
                        store,
                        monitor,
                        checkpoint,
                        "partial" if checkpoint.get("incomplete_sources") else "complete",
                    )
                    return 0, 0, True
            await _save(store, monitor, checkpoint, "pending")
            return 0, 0, False
        thread_id = threads[index]
        try:
            refs = await thread_message_ids(
                client=client,
                token=grant.token,
                thread_id=thread_id,
                require_current=grant.require_current,
            )
        except CompleteMailReadError as exc:
            if exc.code not in _SOURCE_INCOMPLETE:
                raise
            _mark_incomplete(checkpoint, thread_id, exc.code)
            checkpoint["thread_index"] += 1
            checkpoint["failed_this_thread"] = False
            await _save(store, monitor, checkpoint, "partial")
            return 0, 0, False
        eligible = [
            message_id
            for message_id, internal_date_ms in refs
            if internal_date_ms >= checkpoint["cutoff_ms"]
            and (checkpoint["mode"] != "bootstrap" or internal_date_ms <= checkpoint["snapshot_ms"])
        ]
        if not eligible:
            checkpoint["thread_index"] += 1
        else:
            checkpoint["thread_messages"] = eligible
            checkpoint["message_index"] = 0
        await _save(store, monitor, checkpoint, "pending")
        return 0, 0, False

    if checkpoint["mode"] == "retry":
        checkpoint["mode"] = "history"
        await _save(
            store,
            monitor,
            checkpoint,
            "partial" if checkpoint.get("incomplete_sources") else "complete",
        )
        return 0, 0, True
    if checkpoint["mode"] == "bootstrap":
        page = await list_message_page(
            client=client,
            token=grant.token,
            after_ms=checkpoint["cutoff_ms"],
            before_ms=checkpoint["snapshot_ms"],
            page_token=checkpoint["page_token"],
            require_current=grant.require_current,
        )
        checkpoint["pending_threads"] = list(dict.fromkeys(thread for _, thread in page.messages))
        checkpoint["next_page_token"] = page.next_page_token
    else:
        refs, next_page, current_id = await history_message_page(
            client=client,
            token=grant.token,
            start_history_id=checkpoint["history_id"],
            page_token=checkpoint["page_token"],
            require_current=grant.require_current,
        )
        checkpoint["pending_threads"] = list(dict.fromkeys(thread for _, thread in refs))
        checkpoint["next_page_token"] = next_page
        checkpoint["history_current_id"] = current_id
    checkpoint["thread_index"] = 0
    if not checkpoint["pending_threads"]:
        checkpoint["page_token"] = checkpoint["next_page_token"]
        checkpoint["next_page_token"] = None
        if checkpoint["page_token"] is None:
            if checkpoint["mode"] == "bootstrap":
                checkpoint["mode"] = "history"
            else:
                checkpoint["history_id"] = checkpoint["history_current_id"]
                if checkpoint.get("incomplete_sources"):
                    checkpoint["mode"] = "retry"
                    checkpoint["pending_threads"] = _next_retry_batch(checkpoint)
                await _save(
                    store,
                    monitor,
                    checkpoint,
                    "partial" if checkpoint.get("incomplete_sources") else "complete",
                )
                return 0, 0, True
    await _save(store, monitor, checkpoint, "pending")
    return 0, 0, False


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
