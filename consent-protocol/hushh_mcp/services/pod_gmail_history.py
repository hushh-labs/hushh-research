"""Bounded Gmail history traversal over the authoritative doorbell checkpoint port.

Cursor publication and queued identifiers retain one sealed compare-and-swap.
No message bodies or model calls are admitted by provider notifications.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional, Protocol

from hushh_mcp.services import pod_gmail_work as work_queue

MAX_PAGES = 5
Listener = Callable[[list[str]], Awaitable[None]]


class GmailDoorbellUnavailable(RuntimeError):
    """Delivery retries; expired history remains pending for explicit recovery."""


class HistoryPort(Protocol):
    @property
    def history_sequence(self) -> int: ...
    async def stored_point(self) -> Optional[dict[str, Any]]: ...
    async def _store(
        self, history_id: int, email: str, *, expected_seq: int | None = None, **extra: Any
    ) -> None: ...
    async def _call(
        self, method: str, path: str, token: str, **kwargs: Any
    ) -> tuple[int, dict[str, Any]]: ...
    async def _history_page(self, token: str, start: int, page: str = "") -> dict[str, Any]: ...
    def _watch_fields(self, point: dict[str, Any]) -> dict[str, Any]: ...


def history_id(value: Any) -> Optional[int]:
    text = str(value or "").strip()
    return int(text) if text.isascii() and text.isdigit() and len(text) <= 20 else None


async def read_page(
    doorbell: HistoryPort, token: str, start: int, page: str = ""
) -> dict[str, Any]:
    params = {
        "startHistoryId": str(start),
        "historyTypes": "messageAdded",
        "labelId": "INBOX",
        "maxResults": 100,
    }
    if page:
        params["pageToken"] = page
    status, body = await doorbell._call("GET", "/history", token, params=params)
    if status == 404:
        raise GmailDoorbellUnavailable("HISTORY_GAP_REQUIRES_RECOVERY")
    if status != 200 or history_id(body.get("historyId")) is None:
        raise GmailDoorbellUnavailable("HISTORY_UNAVAILABLE")
    ids: list[str] = []
    for entry in body.get("history") or []:
        for added in (entry or {}).get("messagesAdded") or []:
            message_id = str(((added or {}).get("message") or {}).get("id") or "")
            if message_id and message_id not in ids:
                if len(message_id) > 256 or len(ids) >= 1000:
                    raise GmailDoorbellUnavailable("HISTORY_PAGE_TOO_LARGE")
                ids.append(message_id)
    next_page = str(body.get("nextPageToken") or "")
    if len(next_page) > 4096:
        raise GmailDoorbellUnavailable("HISTORY_PAGE_TOO_LARGE")
    return {"ids": ids, "next": next_page, "newest": str(body["historyId"])}


async def prepare_batch(
    doorbell: HistoryPort,
    token: str,
    start: int,
    email: str,
    point: dict[str, Any],
    pending: dict[str, Any],
    observed_seq: int,
    binding: dict[str, str],
    listeners: tuple[Listener, ...],
) -> tuple[dict[str, Any], dict[str, Any], int]:
    batch = pending.get("batch")
    if batch is None:
        try:
            batch = await doorbell._history_page(token, start, str(pending.get("page") or ""))
        except GmailDoorbellUnavailable as exc:
            pending["errorCode"] = str(exc)
            await doorbell._store(
                start,
                email,
                expected_seq=observed_seq,
                **doorbell._watch_fields(point),
                pending=pending,
            )
            raise
        pending["batch"] = batch
        pending.pop("errorCode", None)
        await doorbell._store(
            start,
            email,
            expected_seq=observed_seq,
            **doorbell._watch_fields(point),
            pending=pending,
        )
        observed_seq = doorbell.history_sequence
    # Sinks must commit durably before returning and dedupe replayed IDs.
    # A crash can repeat a page, but can never publish a cursor ahead of it.
    try:
        # The identifier consumer and cursor share one sealed CAS below.
        # Optional sinks must also be durable and idempotent before return.
        work = work_queue.enqueue(point, list(batch["ids"]), binding)
        for listener in listeners:
            await listener(list(batch["ids"]))
        work_queue.require_binding(binding)
    except Exception as exc:
        reason = str(exc)
        pending["errorCode"] = (
            reason
            if reason
            in {
                "OWNER_READ_BACKLOG_FULL",
                "MAILBOX_CHANGED_REQUIRES_RECOVERY",
                "MAILBOX_CONNECTION_UNAVAILABLE",
            }
            else "LISTENER_UNAVAILABLE"
        )
        await doorbell._store(
            start,
            email,
            expected_seq=observed_seq,
            **doorbell._watch_fields(point),
            pending=pending,
        )
        raise
    return batch, work, observed_seq


async def advance(
    doorbell: HistoryPort,
    token: str,
    email: str,
    to: Optional[int],
    binding: dict[str, str],
    listeners: tuple[Listener, ...],
) -> dict[str, Any]:
    work_queue.require_binding(binding)
    point = await doorbell.stored_point()
    start = history_id((point or {}).get("historyId"))
    if start is None:
        raise GmailDoorbellUnavailable("WATCH_BASELINE_REQUIRED")
    if (
        point.get("emailAddress") != email
        or point.get("accountSubject") != binding["accountSubject"]
    ):
        raise GmailDoorbellUnavailable("MAILBOX_CHANGED_REQUIRES_RECOVERY")
    if (point.get("work") or {}).get("messageIds"):
        work_queue.require_binding(point["work"])
    pending = dict(point.get("pending") or {})
    if pending.get("batch") and not pending.get("binding"):
        raise GmailDoorbellUnavailable("MAILBOX_CHANGED_REQUIRES_RECOVERY")
    if pending.get("binding"):
        work_queue.require_binding(pending["binding"])
    if to is not None and to <= start and not pending:
        return {"status": "duplicate", "new": 0}
    target = max(history_id(pending.get("target")) or start, to or start)
    if not pending or target != history_id(pending.get("target")):
        pending.update(target=str(target), binding=binding)
        await doorbell._store(start, email, **doorbell._watch_fields(point), pending=pending)
    count = 0
    for _ in range(MAX_PAGES):
        point = await doorbell.stored_point()
        observed_seq = doorbell.history_sequence
        if int(point["historyId"]) != start:
            raise GmailDoorbellUnavailable("WORK_CHANGED_RETRY")
        pending = dict(point.get("pending") or {})
        batch, work, observed_seq = await prepare_batch(
            doorbell, token, start, email, point, pending, observed_seq, binding, listeners
        )
        count += len(batch["ids"])
        fields = {**doorbell._watch_fields(point), "work": work}
        if batch["next"]:
            pending.pop("batch", None)
            pending.pop("errorCode", None)
            pending.update(
                page=batch["next"],
                newest=str(max(history_id(pending.get("newest")) or start, int(batch["newest"]))),
            )
            await doorbell._store(
                start,
                email,
                expected_seq=observed_seq,
                **fields,
                pending=pending,
            )
            continue
        newest = max(start, int(batch["newest"]), history_id(pending.get("newest")) or start)
        # Only Gmail's fully drained history supplies the completed highwater.
        remaining = {"target": pending["target"]} if target > newest else {}
        await doorbell._store(
            newest,
            email,
            expected_seq=observed_seq,
            **fields,
            pending=remaining,
        )
        return {"status": "pending" if remaining else "queued_for_owner_read", "new": count}
    return {"status": "pending", "new": count}


def watch_fields(point: dict[str, Any]) -> dict[str, Any]:
    return {
        key: point[key]
        for key in (
            "watchExpiresMs",
            "watchRenewedMs",
            "watchTopic",
            "watchConfigGeneration",
            "work",
            "accountSubject",
        )
        if key in point
    }


async def notification_status(doorbell: HistoryPort) -> dict[str, Any]:
    """Owner/operator projection; no mailbox address or message identifiers."""
    point = await doorbell.stored_point() or {}
    pending = point.get("pending") or {}
    queued = len((point.get("work") or {}).get("messageIds") or [])
    return {
        "status": "pending" if pending else "queued_for_owner_read" if queued else "idle",
        "errorCode": pending.get("errorCode"),
        "pagePending": bool(pending.get("page")),
        "batchCount": len((pending.get("batch") or {}).get("ids", [])),
        "queuedCount": queued,
        "watchExpiresMs": point.get("watchExpiresMs"),
        "configGeneration": point.get("watchConfigGeneration"),
    }
