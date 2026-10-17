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

from hushh_mcp.services import pod_gmail_history as history
from hushh_mcp.services import pod_gmail_work as work_queue
from hushh_mcp.services.pod_connector_tokens import ConnectorTokenError, google_token_source
from hushh_mcp.services.pod_gmail_history import (
    GmailDoorbellUnavailable as GmailDoorbellUnavailable,
)
from hushh_mcp.services.pod_gmail_history import history_id as _history_id

logger = logging.getLogger(__name__)

WATCH_KIND = "pod_gmail_watch_v1"
RENEW_WATCH = "renew-watch"
_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
Listener = Callable[[list[str]], Awaitable[None]]
_LISTENERS: list[Listener] = []


def on_new_mail(listener: Listener) -> None:
    """Register an idempotent sink; return only after durable identifier processing.

    Delivery may repeat a page after a crash or another sink's failure. Deduplicate
    by connected mailbox and message ID. A listener must not call a model here.
    """
    if listener not in _LISTENERS:
        _LISTENERS.append(listener)


def mail_topic() -> str:
    """Explicit topic in the OAuth developer project, on either owner cloud."""
    topic = (os.environ.get("POD_GMAIL_TOPIC") or "").strip()
    return (
        topic
        if re.fullmatch(r"projects/[a-z0-9-]+/topics/[A-Za-z][A-Za-z0-9_.~+%-]{2,254}", topic)
        else ""
    )


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

    async def _require_authority(self) -> None:
        from hushh_mcp.services.pod_role import require_serving_role
        from hushh_mcp.services.pod_session_authority import active_session_authority

        await require_serving_role()
        authority = active_session_authority()
        if authority is None:
            raise GmailDoorbellUnavailable("POD_AUTHORITY_UNAVAILABLE")
        await authority.require_held()

    async def _token(self) -> str:
        await self._require_authority()
        source = self._source if self._source is not None else google_token_source()
        try:
            return str(await source.access_token("gmail", "read"))
        except ConnectorTokenError as exc:
            raise GmailDoorbellUnavailable(exc.code) from None

    async def _call(
        self, method: str, path: str, token: str, **kwargs: Any
    ) -> tuple[int, dict[str, Any]]:
        await self._require_authority()
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
        await self._require_authority()
        log = self._log()
        if log is None:
            raise GmailDoorbellUnavailable("NO_STORE")
        payload = {
            "hushh_id": (os.environ.get("HUSSH_ID") or "").strip(),
            "historyId": str(history_id),
            "emailAddress": email,
            "accountSubject": work_queue.current_binding()["accountSubject"],
            "atMs": int(self._clock() * 1000),
            **extra,
        }
        if payload["accountSubject"] != work_queue.current_binding()["accountSubject"]:
            raise GmailDoorbellUnavailable("MAILBOX_CHANGED_REQUIRES_RECOVERY")
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
        return await history.read_page(self, token, start, page)

    @property
    def history_sequence(self) -> int:
        return self._cursor.seq if self._cursor else 0

    async def _advance(
        self, token: str, email: str, to: Optional[int], binding: dict[str, str]
    ) -> dict[str, Any]:
        return await history.advance(self, token, email, to, binding, tuple(_LISTENERS))

    @staticmethod
    def _watch_fields(point: dict[str, Any]) -> dict[str, Any]:
        return history.watch_fields(point)

    async def notification_status(self) -> dict[str, Any]:
        return await history.notification_status(self)

    async def queued_work(self) -> dict[str, Any] | None:
        """Private receipt used by the owner reader; never sent through the hub."""
        from copy import deepcopy

        point = await self.stored_point() or {}
        work = point.get("work")
        if not work or not work.get("messageIds"):
            return None
        work_queue.require_binding(work)
        return deepcopy(work)

    async def reconcile_missing(self, delivery: dict, require_access: Callable) -> None:
        """An owner read may free IDs Google proves gone; no body or model read."""
        from urllib.parse import quote

        await require_access()
        work_queue.require_binding(delivery)
        token = await self._token()
        gone: list[str] = []
        ids = delivery["messageIds"]
        offset = int(delivery.get("scanOffset") or 0) % len(ids)
        inspected = (ids[offset:] + ids[:offset])[:5]
        for message_id in inspected:
            await require_access()
            work_queue.require_binding(delivery)
            status, _ = await self._call(
                "GET",
                "/messages/" + quote(message_id, safe=""),
                token,
                params={"format": "minimal", "fields": "id"},
            )
            if status == 404:
                gone.append(message_id)
            elif status != 200:
                raise GmailDoorbellUnavailable("PROVIDER_UNREACHABLE")
        await require_access()
        await self.acknowledge_read(delivery, tuple(gone), scan_advance=len(inspected))

    async def acknowledge_read(
        self, delivery: dict, returned: tuple[str, ...], *, scan_advance: int = 0
    ) -> None:
        """Settle only this exact observed queue after a successful owner read."""
        async with self._lock:
            point = await self.stored_point() or {}
            observed_seq = self._cursor.seq if self._cursor else 0
            work = work_queue.settle(point.get("work") or {}, delivery, returned)
            if work and scan_advance:
                work["scanOffset"] = (
                    int(work.get("scanOffset") or 0) + scan_advance - len(returned)
                ) % len(work["messageIds"])
            await self._store(
                int(point["historyId"]),
                point["emailAddress"],
                expected_seq=observed_seq,
                **{**self._watch_fields(point), "work": work},
                pending=point.get("pending", {}),
            )

    async def ring(self, message: dict[str, Any]) -> dict[str, Any]:
        """One Gmail notification ``{emailAddress, historyId}``."""
        incoming = _history_id(message.get("historyId"))
        address = str(message.get("emailAddress") or "").strip().lower()
        if incoming is None or not address:
            return {"status": "ignored", "new": 0}
        async with self._lock:
            binding = work_queue.current_binding()
            token = await self._token()
            email, _current = await self._profile(token)
            if address != email:
                return {"status": "ignored", "new": 0}
            return await self._advance(token, email, incoming, binding)

    async def catch_up(self) -> dict[str, Any]:
        """Bounded startup or authenticated maintenance catch-up, on either cloud."""
        async with self._lock:
            binding = work_queue.current_binding()
            token = await self._token()
            email, current = await self._profile(token)
            return await self._advance(token, email, current, binding)

    async def renew_watch(self) -> dict[str, Any]:
        """Re-arm Gmail on its OAuth-project topic; checkpoint on either owner cloud."""
        topic = mail_topic()
        if not topic:
            return {"status": "not_configured"}
        async with self._lock:
            binding = work_queue.current_binding()
            existing = await self.stored_point()
            if existing and existing.get("accountSubject") != binding["accountSubject"]:
                raise GmailDoorbellUnavailable("MAILBOX_CHANGED_REQUIRES_RECOVERY")
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
            work_queue.require_binding(binding)
            observed_seq = self._cursor.seq if self._cursor else 0
            if point is None and _history_id(body.get("historyId")):
                email, _ = await self._profile(token)
                work_queue.require_binding(binding)
                await self._store(
                    int(str(body["historyId"])),
                    email,
                    expected_seq=observed_seq,
                    accountSubject=binding["accountSubject"],
                )
                point = await self.stored_point()
            if point is None:
                raise GmailDoorbellUnavailable("WATCH_RESPONSE_INVALID")
            await self._store(
                int(point["historyId"]),
                point["emailAddress"],
                accountSubject=binding["accountSubject"],
                work=point.get("work", {}),
                pending=point.get("pending", {}),
                watchExpiresMs=str(body.get("expiration") or ""),
                watchRenewedMs=int(self._clock() * 1000),
                watchTopic=topic,
                watchConfigGeneration=os.getenv("POD_GMAIL_CONFIG_GENERATION", ""),
            )
            return {"status": "watching", "expiration": str(body.get("expiration") or "")}

    async def renew_if_due(self) -> dict[str, Any]:
        """Daily maintenance calls this; no process-lifetime timer is required."""
        if not mail_topic():
            return {"status": "not_configured"}
        point = await self.stored_point() or {}
        if point and point.get("accountSubject") != work_queue.current_binding()["accountSubject"]:
            raise GmailDoorbellUnavailable("MAILBOX_CHANGED_REQUIRES_RECOVERY")
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
