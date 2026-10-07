"""Direct Gmail notification processing for either owner cloud.

Gmail publishes identifiers to an owner-specific topic in its OAuth developer
project. A subscription pushes directly to the owner's configured pod origin.
Pending highwater, page token and identifier batch use the existing sealed owner
log. Bounded pages are retried by Pub/Sub; a completed cursor is committed only
after registered idempotent sinks return from durable processing. Expired history
requires explicit recovery. Daily authenticated maintenance renews the watch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Awaitable, Callable, Optional

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.pod_connector_tokens import ConnectorTokenError, google_token_source

logger = logging.getLogger(__name__)

WATCH_KIND = "pod_gmail_watch_v1"
RENEW_WATCH = "renew-watch"
_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_MAX_PAGES = 5
Listener = Callable[[list[str]], Awaitable[None]]
_LISTENERS: list[Listener] = []


def on_new_mail(listener: Listener) -> None:
    """Register an idempotent sink; return only after durable identifier processing.

    Delivery may repeat a page after a crash or another sink's failure. Deduplicate
    by connected mailbox and message ID. A listener must not call a model here.
    """
    if listener not in _LISTENERS:
        _LISTENERS.append(listener)


def _history_id(value: Any) -> Optional[int]:
    text = str(value or "").strip()
    return int(text) if text.isascii() and text.isdigit() and len(text) <= 20 else None


def mail_topic() -> str:
    """Explicit topic in the OAuth developer project, on either owner cloud."""
    topic = (os.environ.get("POD_GMAIL_TOPIC") or "").strip()
    return (
        topic
        if re.fullmatch(r"projects/[a-z0-9-]+/topics/[A-Za-z][A-Za-z0-9_.~+%-]{2,254}", topic)
        else ""
    )


class GmailDoorbellUnavailable(RuntimeError):
    """Provider delivery retries; expired history remains pending for explicit recovery."""


class PodGmailDoorbell:
    """One agent's mail doorbell: verified rings in, new message ids out."""

    def __init__(
        self,
        *,
        token_source: Any = None,
        log_resolver: Optional[Callable[[], Any]] = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._source = token_source
        self._log_resolver = log_resolver
        self._transport = transport
        self._clock = clock
        self._lock = asyncio.Lock()
        self._cursor: Any = None
        self._point: Optional[dict[str, Any]] = None
        self._projection_log: Any = None

    def _log(self) -> Any:
        if self._log_resolver is not None:
            return self._log_resolver()
        from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

        return _resolve_log()

    async def _token(self) -> str:
        source = self._source if self._source is not None else google_token_source()
        try:
            return str(await source.access_token("gmail", "read"))
        except ConnectorTokenError as exc:
            raise GmailDoorbellUnavailable(exc.code) from None

    async def _call(
        self, method: str, path: str, token: str, **kwargs: Any
    ) -> tuple[int, dict[str, Any]]:
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=15, follow_redirects=False
            ) as client:
                # HTTPX spans would otherwise record history ids from the URL.
                with suppress_instrumentation():
                    response = await client.request(
                        method, _BASE + path, headers={"Authorization": f"Bearer {token}"}, **kwargs
                    )
        except httpx.HTTPError:
            raise GmailDoorbellUnavailable("PROVIDER_UNREACHABLE") from None
        try:
            body = response.json()
        except ValueError:
            body = {}
        return response.status_code, body if isinstance(body, dict) else {}

    async def stored_point(self) -> Optional[dict[str, Any]]:
        log = self._log()
        if log is None:
            raise GmailDoorbellUnavailable("NO_STORE")
        if self._projection_log is not log:
            self._cursor, self._point, self._projection_log = None, None, log
        hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
        latest: Optional[dict[str, Any]] = None

        def visit(record: dict[str, Any]) -> None:
            nonlocal latest
            payload = record.get("payload") or {}
            if (
                latest is None
                and record.get("kind") == WATCH_KIND
                and payload.get("hushh_id") == hushh_id
            ):
                latest = dict(payload)

        # One streaming cold replay, then only new verified records per invocation.
        cursor = await log.fold_since(self._cursor, visit)
        if latest is not None:
            self._point = latest
        self._cursor = cursor
        return dict(self._point) if self._point else None

    async def _store(
        self, history_id: int, email: str, *, expected_seq: int | None = None, **extra: Any
    ) -> None:
        log = self._log()
        if log is None:
            raise GmailDoorbellUnavailable("NO_STORE")
        payload = {
            "hushh_id": (os.environ.get("HUSSH_ID") or "").strip(),
            "historyId": str(history_id),
            "emailAddress": email,
            "atMs": int(self._clock() * 1000),
            **extra,
        }
        await log.append(
            WATCH_KIND,
            payload,
            expected_seq=expected_seq
            if expected_seq is not None
            else (self._cursor.seq if self._cursor else 0),
        )
        if await self.stored_point() != payload:
            raise GmailDoorbellUnavailable("WORK_CHANGED_RETRY")

    async def _profile(self, token: str) -> tuple[str, Optional[int]]:
        status, body = await self._call("GET", "/profile", token)
        if status != 200:
            raise GmailDoorbellUnavailable("PROFILE_UNAVAILABLE")
        email = str(body.get("emailAddress") or "").strip().lower()
        history = _history_id(body.get("historyId"))
        if not email or "@" not in email or history is None:
            raise GmailDoorbellUnavailable("PROFILE_UNAVAILABLE")
        return email, history

    async def _history_page(self, token: str, start: int, page: str = "") -> dict[str, Any]:
        params = {"startHistoryId": str(start), "historyTypes": "messageAdded", "maxResults": 100}
        if page:
            params["pageToken"] = page
        status, body = await self._call("GET", "/history", token, params=params)
        if status == 404:
            raise GmailDoorbellUnavailable("HISTORY_GAP_REQUIRES_RECOVERY")
        if status != 200 or _history_id(body.get("historyId")) is None:
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

    async def _advance(self, token: str, email: str, to: Optional[int]) -> dict[str, Any]:
        point = await self.stored_point()
        start = _history_id((point or {}).get("historyId"))
        if start is None:
            raise GmailDoorbellUnavailable("WATCH_BASELINE_REQUIRED")
        if point.get("emailAddress") != email:
            raise GmailDoorbellUnavailable("MAILBOX_CHANGED_REQUIRES_RECOVERY")
        pending = dict(point.get("pending") or {})
        if to is not None and to <= start and not pending:
            return {"status": "duplicate", "new": 0}
        target = max(_history_id(pending.get("target")) or start, to or start)
        if not pending or target != _history_id(pending.get("target")):
            pending.update(target=str(target))
            await self._store(start, email, **self._watch_fields(point), pending=pending)
        count = 0
        for _ in range(_MAX_PAGES):
            point = await self.stored_point()
            observed_seq = self._cursor.seq if self._cursor else 0
            if int(point["historyId"]) != start:
                raise GmailDoorbellUnavailable("WORK_CHANGED_RETRY")
            pending = dict(point.get("pending") or {})
            batch = pending.get("batch")
            if batch is None:
                try:
                    batch = await self._history_page(token, start, str(pending.get("page") or ""))
                except GmailDoorbellUnavailable as exc:
                    pending["errorCode"] = str(exc)
                    await self._store(
                        start,
                        email,
                        expected_seq=observed_seq,
                        **self._watch_fields(point),
                        pending=pending,
                    )
                    raise
                pending["batch"] = batch
                pending.pop("errorCode", None)
                await self._store(
                    start,
                    email,
                    expected_seq=observed_seq,
                    **self._watch_fields(point),
                    pending=pending,
                )
                observed_seq = self._cursor.seq if self._cursor else 0
            # Sinks must commit durably before returning and dedupe replayed IDs.
            # A crash can repeat a page, but can never publish a cursor ahead of it.
            try:
                for listener in tuple(_LISTENERS):
                    await listener(list(batch["ids"]))
            except Exception:
                pending["errorCode"] = "LISTENER_UNAVAILABLE"
                await self._store(
                    start,
                    email,
                    expected_seq=observed_seq,
                    **self._watch_fields(point),
                    pending=pending,
                )
                raise
            count += len(batch["ids"])
            if batch["next"]:
                pending.pop("batch", None)
                pending.pop("errorCode", None)
                pending.update(
                    page=batch["next"],
                    newest=str(
                        max(_history_id(pending.get("newest")) or start, int(batch["newest"]))
                    ),
                )
                await self._store(
                    start,
                    email,
                    expected_seq=observed_seq,
                    **self._watch_fields(point),
                    pending=pending,
                )
                continue
            newest = max(start, int(batch["newest"]), _history_id(pending.get("newest")) or start)
            # Only Gmail's fully drained history supplies the completed highwater.
            remaining = {"target": pending["target"]} if target > newest else {}
            await self._store(
                newest,
                email,
                expected_seq=observed_seq,
                **self._watch_fields(point),
                pending=remaining,
            )
            return {"status": "pending" if remaining else "processed", "new": count}
        return {"status": "pending", "new": count}

    @staticmethod
    def _watch_fields(point: dict[str, Any]) -> dict[str, Any]:
        return {
            key: point[key]
            for key in ("watchExpiresMs", "watchRenewedMs", "watchTopic", "watchConfigGeneration")
            if key in point
        }

    async def notification_status(self) -> dict[str, Any]:
        """Owner/operator projection; no mailbox address or message identifiers."""
        point = await self.stored_point() or {}
        pending = point.get("pending") or {}
        return {
            "status": "pending" if pending else "idle",
            "errorCode": pending.get("errorCode"),
            "pagePending": bool(pending.get("page")),
            "batchCount": len((pending.get("batch") or {}).get("ids", [])),
            "watchExpiresMs": point.get("watchExpiresMs"),
            "configGeneration": point.get("watchConfigGeneration"),
        }

    async def ring(self, message: dict[str, Any]) -> dict[str, Any]:
        """One Gmail notification ``{emailAddress, historyId}``."""
        incoming = _history_id(message.get("historyId"))
        address = str(message.get("emailAddress") or "").strip().lower()
        if incoming is None or not address:
            return {"status": "ignored", "new": 0}
        async with self._lock:
            token = await self._token()
            email, _current = await self._profile(token)
            if address != email:
                return {"status": "ignored", "new": 0}
            return await self._advance(token, email, incoming)

    async def catch_up(self) -> dict[str, Any]:
        """Bounded startup or authenticated maintenance catch-up, on either cloud."""
        async with self._lock:
            token = await self._token()
            email, current = await self._profile(token)
            return await self._advance(token, email, current)

    async def renew_watch(self) -> dict[str, Any]:
        """Re-arm Gmail on its OAuth-project topic; checkpoint on either owner cloud."""
        topic = mail_topic()
        if not topic:
            return {"status": "not_configured"}
        async with self._lock:
            token = await self._token()
            status, body = await self._call(
                "POST",
                "/watch",
                token,
                json={"topicName": topic, "labelIds": ["INBOX"], "labelFilterBehavior": "INCLUDE"},
            )
            if (
                status != 200
                or _history_id(body.get("historyId")) is None
                or _history_id(body.get("expiration")) is None
            ):
                raise GmailDoorbellUnavailable("WATCH_REFUSED")
            point = await self.stored_point()
            observed_seq = self._cursor.seq if self._cursor else 0
            if point is None and _history_id(body.get("historyId")):
                email, _ = await self._profile(token)
                await self._store(int(str(body["historyId"])), email, expected_seq=observed_seq)
                point = await self.stored_point()
            if point is None:
                raise GmailDoorbellUnavailable("WATCH_RESPONSE_INVALID")
            await self._store(
                int(point["historyId"]),
                point["emailAddress"],
                pending=point.get("pending", {}),
                watchExpiresMs=str(body.get("expiration") or ""),
                watchRenewedMs=int(self._clock() * 1000),
                watchTopic=topic,
                watchConfigGeneration=os.getenv("POD_GMAIL_CONFIG_GENERATION", ""),
            )
            return {"status": "watching", "expiration": str(body.get("expiration") or "")}

    async def renew_if_due(self) -> dict[str, Any]:
        """Daily maintenance calls this; no process-lifetime timer is required."""
        point = await self.stored_point() or {}
        now = int(self._clock() * 1000)
        if (
            point.get("watchTopic") == mail_topic()
            and point.get("watchConfigGeneration") == os.getenv("POD_GMAIL_CONFIG_GENERATION", "")
            and now - int(point.get("watchRenewedMs") or 0) < 24 * 3600 * 1000
            and (_history_id(point.get("watchExpiresMs")) or 0) > now + 3600 * 1000
        ):
            return {"status": "watch_current"}
        return await self.renew_watch()


_DOORBELL: Optional[PodGmailDoorbell] = None


def pod_gmail_doorbell() -> PodGmailDoorbell:
    global _DOORBELL
    if _DOORBELL is None:
        _DOORBELL = PodGmailDoorbell()
    return _DOORBELL


def start_mail_poller() -> Optional["asyncio.Task[None]"]:
    """Compatibility entrypoint: direct provider push replaces warm polling."""
    return None


async def arm_watch_after_connect() -> None:
    """Call after a Gmail login is recorded: arm the watch now rather than at 04:00 UTC."""
    from hushh_mcp.services.compute_backend import (  # noqa: PLC0415
        BACKEND_USER_AZURE,
        BACKEND_USER_GCP,
    )
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_provider  # noqa: PLC0415

    if owner_cloud_provider() not in (BACKEND_USER_GCP, BACKEND_USER_AZURE):
        return
    try:
        await pod_gmail_doorbell().renew_watch()
    except Exception as exc:  # noqa: BLE001 - the daily renewal retries
        logger.warning("pod_gmail_doorbell.arm_failed reason=%s", type(exc).__name__)


def decode_push(body: Any) -> Optional[Any]:
    """A Pub/Sub push body's message: ``RENEW_WATCH``, a notification dict, or None."""
    import base64  # noqa: PLC0415

    message = body.get("message") if isinstance(body, dict) else None
    data = message.get("data") if isinstance(message, dict) else None
    if not isinstance(data, str) or len(data) > 8192:
        return None
    try:
        text = base64.b64decode(data, validate=True).decode("utf-8").strip()
    except (ValueError, UnicodeDecodeError):
        return None
    if text == RENEW_WATCH:
        return RENEW_WATCH
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


__all__ = [
    "RENEW_WATCH",
    "WATCH_KIND",
    "GmailDoorbellUnavailable",
    "PodGmailDoorbell",
    "arm_watch_after_connect",
    "decode_push",
    "mail_topic",
    "on_new_mail",
    "pod_gmail_doorbell",
    "start_mail_poller",
]
