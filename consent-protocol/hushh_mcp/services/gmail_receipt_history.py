"""Bounded Gmail history protocol with provider and owner authority injected."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

import httpx

from hushh_mcp.services.gmail_receipt_continuity import history_changes, open_state, seal_state
from hushh_mcp.services.gmail_receipts_service import GmailApiError

MAX_PAGE = 50
Projection = tuple[dict[str, Any] | None, dict[str, Any], str | None]


class ProviderGet(Protocol):
    async def __call__(
        self, *, client: httpx.AsyncClient, path: str, params: dict[str, Any], budget: list[int]
    ) -> dict[str, Any]: ...


class MessageFetch(Protocol):
    async def __call__(
        self,
        *,
        client: httpx.AsyncClient,
        message_ids: list[str],
        budget: list[int],
        missing: list[str],
    ) -> list[dict[str, Any]]: ...


class ReceiptProject(Protocol):
    async def __call__(self, *, messages: list[dict[str, Any]]) -> list[Projection]: ...


@dataclass(frozen=True)
class HistoryPorts:
    get: ProviderGet
    fetch_messages: MessageFetch
    project_messages: ReceiptProject
    require_current: Callable[[], Awaitable[None]]
    event_id: Callable[[str], str]
    pagination_token: Callable[[Any], str | None]


def read_history_state(
    secret: bytes,
    binding: list[str],
    checkpoint: str | None,
    cursor: str | None,
    page: int,
    per_page: int,
) -> tuple[dict[str, Any], str, int]:
    state = open_state(secret, binding, cursor or checkpoint or "")
    continuation = cursor is not None
    if state.get("kind") != ("continuation" if continuation else "checkpoint"):
        raise GmailApiError(
            "Saved Mail progress is invalid.",
            status_code=409,
            code="GMAIL_RECEIPT_CHECKPOINT_EXPIRED",
        )
    now = int(datetime.now(timezone.utc).timestamp())
    start = state.get("history")
    if not isinstance(start, str) or not re.fullmatch(r"[0-9]{1,30}", start):
        raise GmailApiError(
            "Saved Mail progress is invalid.",
            status_code=409,
            code="GMAIL_RECEIPT_CHECKPOINT_EXPIRED",
        )
    if continuation and (
        state.get("page") != page
        or state.get("per_page") != per_page
        or not isinstance(state.get("before"), int)
        or not 0 <= now - state["before"] < 7200
    ):
        raise GmailApiError(
            "Receipt continuation expired.",
            status_code=409,
            code="GMAIL_RECEIPT_CURSOR_EXPIRED",
        )
    if not continuation and page != 1:
        raise GmailApiError(
            "Start receipt reconciliation again.",
            status_code=409,
            code="GMAIL_RECEIPT_CURSOR_EXPIRED",
        )
    return state, start, now


@dataclass(frozen=True)
class HistorySelection:
    selected: list[tuple[str, bool]]
    next_token: str | None
    inside_page: bool
    more: bool
    fingerprint: str
    offset: int


def select_history(
    history: dict[str, Any],
    state: dict[str, Any],
    target: str,
    per_page: int,
    pagination_token: Callable[[Any], str | None],
) -> HistorySelection:
    try:
        response_history = history.get("historyId")
        if (
            not isinstance(response_history, str)
            or not re.fullmatch(r"[0-9]{1,30}", response_history)
            or int(response_history) < int(target)
        ):
            raise ValueError
        changes = history_changes(history, target)
        fingerprint = hashlib.sha256(json.dumps(changes).encode()).hexdigest()
        offset = state.get("offset", 0)
        if (
            not isinstance(offset, int)
            or not 0 <= offset <= len(changes)
            or (offset and state.get("fingerprint") != fingerprint)
        ):
            raise ValueError
        selected = changes[offset : offset + per_page]
        next_token = pagination_token(history.get("nextPageToken"))
        if any(int(record["id"]) > int(target) for record in history.get("history", [])):
            next_token = None
        # Replay this exact provider page until every changed message is consumed.
        inside_page = offset + per_page < len(changes)
        more = inside_page or next_token is not None
        if next_token and next_token == state.get("token") and not inside_page:
            raise ValueError
    except (ValueError, TypeError):
        raise GmailApiError(
            "Mail progress changed; try again.",
            status_code=409,
            code="GMAIL_RECEIPT_CURSOR_EXPIRED",
        ) from None
    return HistorySelection(
        selected=selected,
        next_token=next_token,
        inside_page=inside_page,
        more=more,
        fingerprint=fingerprint,
        offset=offset,
    )


async def history_target(
    ports: HistoryPorts,
    client: httpx.AsyncClient,
    budget: list[int],
    state: dict[str, Any],
    start: str,
    continuation: bool,
) -> str:
    target = state.get("target")
    if not continuation:
        profile = await ports.get(
            client=client, path="/profile", params={"fields": "historyId"}, budget=budget
        )
        target = str(profile.get("historyId", ""))
    if (
        not isinstance(target, str)
        or not re.fullmatch(r"[0-9]{1,30}", target)
        or int(target) < int(start)
    ):
        raise GmailApiError(
            "Saved Mail progress needs reconciliation.",
            status_code=409,
            code="GMAIL_RECEIPT_CHECKPOINT_EXPIRED",
        )
    return target


async def read_history(
    ports: HistoryPorts,
    client: httpx.AsyncClient,
    budget: list[int],
    state: dict[str, Any],
    start: str,
) -> dict[str, Any]:
    params: dict[str, Any] = {"startHistoryId": start, "maxResults": 10}
    if state.get("token"):
        params["pageToken"] = state["token"]
    try:
        return await ports.get(client=client, path="/history", params=params, budget=budget)
    except GmailApiError as exc:
        if exc.code == "GMAIL_RECEIPT_NOT_FOUND":
            raise GmailApiError(
                "Mail progress expired; saved receipts are safe.",
                status_code=409,
                code="GMAIL_RECEIPT_CHECKPOINT_EXPIRED",
            ) from None
        raise


def delta_coverage(
    selected: list[tuple[str, bool]],
    eligible: list[dict[str, Any]],
    items: list[dict[str, Any]],
    projected: list[Projection],
    page: int,
    per_page: int,
    more: bool,
    now: int,
) -> dict[str, Any]:
    return {
        "source": "gmail_live",
        "listed_count": len(selected),
        "candidate_count": len(eligible),
        "matched_count": len(items),
        "pages_scanned": 1,
        "max_messages": per_page,
        "max_pages": MAX_PAGE,
        "max_scan_messages": 300,
        "window_start": None,
        "window_end": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        "reached_limit": more and page == MAX_PAGE,
        "query_scope": "receipt_signals_all_mail_except_spam_trash",
        "rejection_counts": {
            "missing_receipt_signal": sum(
                reason == "missing_receipt_signal" for _, _, reason in projected
            ),
            "extractor_not_receipt": sum(
                reason == "extractor_not_receipt" for _, _, reason in projected
            ),
        },
        "evidence_counts": {
            key: 0
            for key in (
                "gmail_category",
                "subject_signal",
                "body_signal",
                "verified_merchant",
                "order_candidate",
                "total_candidate",
            )
        },
    }


def delta_response(
    *,
    secret: bytes,
    binding: list[str],
    event_id: Callable[[str], str],
    state: dict[str, Any],
    start: str,
    target: str,
    now: int,
    page: int,
    per_page: int,
    selected: list[tuple[str, bool]],
    next_token: str | None,
    inside_page: bool,
    more: bool,
    fingerprint: str,
    offset: int,
    missing: list[str],
    eligible: list[dict[str, Any]],
    projected: list[Projection],
) -> dict[str, Any]:
    items = []
    for item, _evidence_payload, _reason in projected:
        if item is not None:
            public = dict(item)
            public["source_evidence"] = public.pop("_source_evidence", [])
            items.append(public)
    continuation_state = {
        "kind": "continuation",
        "history": start,
        "target": target,
        "before": state.get("before", now),
        "page": page % MAX_PAGE + 1,
        "per_page": per_page,
        "token": state.get("token") if inside_page else next_token,
        "offset": offset + per_page if inside_page else 0,
        "fingerprint": fingerprint if inside_page else None,
    }
    return {
        "items": items,
        "page": page,
        "per_page": per_page,
        "returned_count": len(items),
        "sync_mode": "delta",
        "has_more": more,
        "next_cursor": seal_state(secret, binding, continuation_state) if more else None,
        "checkpoint": seal_state(secret, binding, {"history": target, "kind": "checkpoint"})
        if not more
        else None,
        "unavailable_events": [event_id(identity) for identity in missing],
        "coverage": delta_coverage(selected, eligible, items, projected, page, per_page, more, now),
    }


async def scan_history_page(
    *,
    ports: HistoryPorts,
    transport: httpx.AsyncBaseTransport | None,
    secret: bytes,
    binding: list[str],
    checkpoint: str | None,
    cursor: str | None,
    page: int,
    per_page: int,
    response_budget: int,
) -> dict[str, Any]:
    state, start, now = read_history_state(secret, binding, checkpoint, cursor, page, per_page)
    budget = [response_budget]
    async with httpx.AsyncClient(transport=transport, timeout=10, follow_redirects=False) as client:
        target = await history_target(ports, client, budget, state, start, cursor is not None)
        history = await read_history(ports, client, budget, state, start)
        selection = select_history(history, state, target, per_page, ports.pagination_token)
        missing = [identity for identity, deleted in selection.selected if deleted]
        ids = [identity for identity, deleted in selection.selected if not deleted]
        messages = await ports.fetch_messages(
            client=client, message_ids=ids, budget=budget, missing=missing
        )
        eligible = [
            message
            for message in messages
            if not set(message.get("labelIds", [])) & {"SPAM", "TRASH"}
        ]
        missing.extend(str(message["id"]) for message in messages if message not in eligible)
        projected = await ports.project_messages(messages=eligible)
    await ports.require_current()
    return delta_response(
        secret=secret,
        binding=binding,
        event_id=ports.event_id,
        state=state,
        start=start,
        target=target,
        now=now,
        page=page,
        per_page=per_page,
        selected=selection.selected,
        next_token=selection.next_token,
        inside_page=selection.inside_page,
        more=selection.more,
        fingerprint=selection.fingerprint,
        offset=selection.offset,
        missing=missing,
        eligible=eligible,
        projected=projected,
    )
