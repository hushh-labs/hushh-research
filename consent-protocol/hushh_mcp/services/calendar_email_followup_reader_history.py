"""Gmail ``users.history.list`` pages for incremental Calendar follow-up scans.

One page reports new mail, deletions and moves to Trash/Spam, so a later scan
reads only what changed instead of rescanning completed messages.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from hushh_mcp.services.calendar_email_followup_reader import (
    _GMAIL_BASE,
    _PROVIDER_ID,
    CompleteMailReadError,
    _bounded_get,
)

_REMOVED_LABELS = frozenset({"TRASH", "SPAM"})
# The HTTP response is already capped at 4 MiB; a busy History record must not
# stall all later mail at an arbitrary 200 IDs.
_MAX_PAGE_CHANGES = 10000


@dataclass(frozen=True)
class HistoryChanges:
    added: tuple[tuple[str, str], ...]
    deleted: tuple[tuple[str, str], ...]
    next_page_token: str | None
    history_id: str


def _invalid() -> CompleteMailReadError:
    return CompleteMailReadError("invalid_provider_response")


def _history_message(item: Any) -> tuple[str, str]:
    if not isinstance(item, dict) or not all(
        isinstance(item.get(key), str) and _PROVIDER_ID.fullmatch(item[key])
        for key in ("id", "threadId")
    ):
        raise _invalid()
    return item["id"], item["threadId"]


def _collect_record(history: Any, added: dict[str, str], deleted: dict[str, str]) -> None:
    """Fold one history record into the page's added/deleted message maps."""
    if not isinstance(history, dict):
        raise _invalid()
    for key, target in (("messagesAdded", added), ("messagesDeleted", deleted)):
        entries = history.get(key, [])
        if not isinstance(entries, list):
            raise _invalid()
        for entry in entries:
            message_id, thread_id = _history_message(
                entry.get("message") if isinstance(entry, dict) else None
            )
            target[message_id] = thread_id
    labels = history.get("labelsAdded", [])
    if not isinstance(labels, list):
        raise _invalid()
    for entry in labels:
        if not isinstance(entry, dict):
            raise _invalid()
        label_ids = entry.get("labelIds", [])
        if not isinstance(label_ids, list) or any(not isinstance(x, str) for x in label_ids):
            raise _invalid()
        if _REMOVED_LABELS & set(label_ids):
            message_id, thread_id = _history_message(entry.get("message"))
            deleted[message_id] = thread_id
    if len(added) + len(deleted) > _MAX_PAGE_CHANGES:
        raise CompleteMailReadError("history_page_too_large")


def _page_cursor(payload: dict[str, Any]) -> tuple[str | None, str]:
    next_token = payload.get("nextPageToken")
    current = payload.get("historyId")
    if (
        next_token is not None
        and (not isinstance(next_token, str) or len(next_token) > 2048)
        or not isinstance(current, str)
        or not current.isdigit()
    ):
        raise _invalid()
    return next_token, current


async def history_changes_page(
    *,
    client: httpx.AsyncClient,
    token: str,
    start_history_id: str,
    page_token: str | None,
    require_current: Callable[[], Awaitable[None]],
) -> HistoryChanges:
    """One users.history.list page: new mail, deletions and moves to Trash/Spam.

    Gmail answers 404 once the starting historyId is too old. That is reported
    as ``history_gap`` so the caller runs a bounded recovery synchronization
    instead of silently skipping mail that arrived during the gap.
    """
    if not start_history_id.isdigit() or (page_token and len(page_token) > 2048):
        raise CompleteMailReadError("invalid_scan_checkpoint")
    params: list[tuple[str, str]] = [
        ("startHistoryId", start_history_id),
        ("maxResults", "25"),
        ("historyTypes", "messageAdded"),
        ("historyTypes", "messageDeleted"),
        ("historyTypes", "labelAdded"),
    ]
    if page_token:
        params.append(("pageToken", page_token))
    await require_current()
    try:
        payload = await _bounded_get(
            client, url=f"{_GMAIL_BASE}/history", token=token, params=params
        )
    except CompleteMailReadError as exc:
        if exc.code == "source_unavailable":
            raise CompleteMailReadError("history_gap") from None
        raise
    await require_current()
    raw = payload.get("history", [])
    if not isinstance(raw, list) or len(raw) > 25:
        raise _invalid()
    added: dict[str, str] = {}
    deleted: dict[str, str] = {}
    for history in raw:
        _collect_record(history, added, deleted)
    # A message added and then deleted within one page is simply gone.
    for message_id in deleted:
        added.pop(message_id, None)
    next_token, current_history_id = _page_cursor(payload)
    return HistoryChanges(
        added=tuple(added.items()),
        deleted=tuple(deleted.items()),
        next_page_token=next_token,
        history_id=current_history_id,
    )


async def history_message_page(
    *,
    client: httpx.AsyncClient,
    token: str,
    start_history_id: str,
    page_token: str | None,
    require_current: Callable[[], Awaitable[None]],
) -> tuple[tuple[tuple[str, str], ...], str | None, str]:
    """Compatibility view of one history page that returns added mail only."""
    page = await history_changes_page(
        client=client,
        token=token,
        start_history_id=start_history_id,
        page_token=page_token,
        require_current=require_current,
    )
    return page.added, page.next_page_token, page.history_id
