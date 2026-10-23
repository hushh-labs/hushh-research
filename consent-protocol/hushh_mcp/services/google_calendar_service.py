"""Live Google Calendar reads and confirmation-bound mutations.

Calendar contents are fetched from Google when needed. Only short-lived action
plans are stored locally; the service does not turn events into PKM or a
long-lived cache. Scheduling proposals include the live overlapping events so
the owner can make an informed, explicit choice before anything changes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from typing import Any, Literal
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from db.db_client import get_db
from hushh_mcp.consent.audit_logger import get_trace_id
from hushh_mcp.services.google_calendar_proposals import (
    CalendarProposalStore,
    CalendarTokens,
    SqlCalendarProposalStore,
)
from hushh_mcp.services.google_connection_service import (
    CALENDAR_LIST_READ_SCOPE,
    GoogleConnectionError,
    GoogleConnectionService,
    get_google_connection_service,
)
from hushh_mcp.services.product_value_receipts import capture_value_epoch, record_calendar_effect

_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"
logger = logging.getLogger(__name__)
# events.list returns at most 250 events per page by default
# (https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
# One page, never an unbounded walk: a caller learns when more exist.
EVENT_PAGE_MAX = 250
_EVENT_QUERY_MAX_CHARS = 256
CALENDAR_READ_DEADLINE_SECONDS = 12.0
_CALENDAR_READ_ATTEMPT_TIMEOUT = 5.0
_CALENDAR_READ_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_RATE_LIMIT_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"})
_MISSING = object()
# Attendee fields an events.patch may carry back. Read-only fields (id, self,
# organizer) are recomputed by Google and never echoed.
_WRITABLE_ATTENDEE_FIELDS = frozenset(
    {
        "email",
        "displayName",
        "optional",
        "responseStatus",
        "comment",
        "additionalGuests",
        "resource",
    }
)


def _mapping(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _provider_color(value: object) -> str | None:
    return (
        value.lower()
        if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value)
        else None
    )


class _MeetingAnchors(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            self.links.extend(value for name, value in attrs if name.lower() == "href" and value)


def _meeting_link(value: object) -> tuple[str, str] | None:
    """Admit actual HTTPS join paths, never provider homepages or booking links."""
    if not isinstance(value, str) or len(value) > 8192:
        return None
    candidate = unescape(value).strip()
    if any(ord(character) < 32 for character in candidate):
        return None
    try:
        url = urlsplit(candidate)
        if (
            url.scheme != "https"
            or url.username is not None
            or url.password is not None
            or url.port not in (None, 443)
        ):
            return None
        host, path = (url.hostname or "").lower(), url.path
        if host == "meet.google.com" and (
            re.fullmatch(r"/[a-z]{3}-[a-z]{4}-[a-z]{3}/?", path)
            or re.fullmatch(r"/lookup/[A-Za-z0-9_-]+/?", path)
        ):
            return candidate, "Google Meet"
        if any(
            host == suffix or host.endswith("." + suffix) for suffix in ("zoom.us", "zoomgov.com")
        ) and (
            re.fullmatch(r"/(?:j|w|wc/j)/[0-9]{9,12}/?", path)
            or re.fullmatch(r"/wc/[0-9]{9,12}/join/?", path)
            or re.fullmatch(r"/my/[A-Za-z0-9][A-Za-z0-9._-]{0,99}/?", path)
        ):
            return candidate, "Zoom Meeting"
        if host in {"teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"} and (
            re.fullmatch(r"/l/meetup-join/[^\s<>]+", path)
            or re.fullmatch(r"/meet/[0-9]{10,40}/?", path)
        ):
            return candidate, "Microsoft Teams"
    except ValueError:
        return None
    return None


def _event_meeting(event: dict[str, Any]) -> tuple[str, str] | None:
    conference = _mapping(event.get("conferenceData"))
    entries = conference.get("entryPoints")
    candidates = (
        [
            item.get("uri")
            for item in entries
            if isinstance(item, dict) and item.get("entryPointType") == "video"
        ]
        if isinstance(entries, list)
        else []
    )
    candidates.append(event.get("hangoutLink"))
    for field in ("description", "location"):
        text = event.get(field)
        if not isinstance(text, str):
            continue
        text = unescape(text)
        anchors = _MeetingAnchors()
        try:
            anchors.feed(text)
        except ValueError:
            pass
        candidates.extend(anchors.links)
        candidates.extend(
            match.rstrip(".,;)]}") for match in re.findall(r"https://[^\s<>\"']+", text)
        )
    return next((link for value in candidates if (link := _meeting_link(value))), None)


class GoogleCalendarService:
    def __init__(
        self,
        *,
        db: Any | None = None,
        connections: GoogleConnectionService | CalendarTokens | None = None,
        proposals: CalendarProposalStore | None = None,
    ) -> None:
        # An injected store (the owner's own log in their agent) needs no hub database.
        self.db = db if db is not None or proposals is not None else get_db()
        self.connections = connections or get_google_connection_service()
        self.proposals = proposals or SqlCalendarProposalStore(self._execute_raw_async)

    async def _execute_raw_async(self, sql: str, params: dict[str, Any] | None = None) -> Any:
        """Keep proposal persistence from blocking Calendar's async routes."""
        return await asyncio.to_thread(self.db.execute_raw, sql, params)

    async def _purge_expired_proposals(self, *, user_id: str) -> None:
        """Remove terminal and expired plans on the next Calendar mutation."""
        await self.proposals.purge(user_id=user_id)

    @staticmethod
    def _iso(value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise GoogleConnectionError(
                "Calendar date-time must be ISO-8601", status_code=422
            ) from exc
        if parsed.tzinfo is None:
            raise GoogleConnectionError(
                "Calendar date-time must include a time zone", status_code=422
            )
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")

    async def _request(
        self,
        *,
        user_id: str,
        method: str,
        path: str,
        access: Literal["read", "manage"],
        params: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        required_scope: str | None = None,
        expected_binding: tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        # Include token refresh and grant checks in one wall-clock read budget.
        # Mutations keep their existing timeout and are never retried here.
        try:
            async with asyncio.timeout(
                CALENDAR_READ_DEADLINE_SECONDS if access == "read" else None
            ):
                return await self._request_with_authority(
                    user_id=user_id,
                    method=method,
                    path=path,
                    access=access,
                    params=params,
                    payload=payload,
                    headers=headers,
                    required_scope=required_scope,
                    expected_binding=expected_binding,
                )
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise GoogleConnectionError(
                "Google Calendar took too long to respond",
                status_code=504,
                reason_code="calendar_timeout",
            ) from exc
        except httpx.TransportError as exc:
            raise GoogleConnectionError(
                "Google Calendar is temporarily unavailable",
                status_code=503,
                reason_code="calendar_unavailable",
            ) from exc

    async def _request_with_authority(
        self,
        *,
        user_id: str,
        method: str,
        path: str,
        access: Literal["read", "manage"],
        params: dict[str, Any] | None,
        payload: dict[str, Any] | None,
        headers: dict[str, str] | None,
        required_scope: str | None,
        expected_binding: tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        before = (
            await self.connections.read_grant_binding(user_id=user_id, service="calendar")
            if access == "read" or expected_binding is not None
            else None
        )
        if expected_binding is not None and before != expected_binding:
            raise GoogleConnectionError(
                "Google Calendar connection changed",
                status_code=409,
                reason_code="calendar_connection_changed",
            )
        if access == "read" and before is None:
            status_reader = getattr(self.connections, "status", None)
            status = (
                await status_reader(user_id=user_id, service="calendar")
                if callable(status_reader)
                else {}
            )
            if status.get("status") == "needs_reauth":
                raise GoogleConnectionError(
                    "Reconnect Google Calendar",
                    status_code=401,
                    reason_code="calendar_reauthorization_required",
                )
            permission_missing = bool(status.get("connected"))
            raise GoogleConnectionError(
                "Allow Google Calendar reading"
                if permission_missing
                else "Connect Google Calendar first",
                status_code=403,
                reason_code="calendar_permission_required"
                if permission_missing
                else "calendar_not_connected",
            )
        try:
            token = await self.connections.access_token(
                user_id=user_id, service="calendar", access_level=access
            )
        except GoogleConnectionError as exc:
            reason = {
                "google_not_connected": "calendar_not_connected",
                "google_permission_required": "calendar_permission_required",
                "google_reauthorization_required": "calendar_reauthorization_required",
            }.get(exc.reason_code or "")
            if exc.status_code == 401:
                reason = "calendar_reauthorization_required"
            raise GoogleConnectionError(
                str(exc), status_code=exc.status_code, reason_code=reason or exc.reason_code
            ) from exc
        current = (
            await self.connections.read_grant_binding(user_id=user_id, service="calendar")
            if access == "read" or expected_binding is not None
            else None
        )
        if (access == "read" or expected_binding is not None) and (
            current is None or current != before
        ):
            raise GoogleConnectionError(
                "Google Calendar connection changed",
                status_code=409,
                reason_code="calendar_connection_changed",
            )
        if required_scope and not await self.connections.has_service_scope(
            user_id=user_id, service="calendar", scope=required_scope
        ):
            raise GoogleConnectionError(
                "Allow access to your subscribed calendars to use this read",
                status_code=403,
                reason_code="calendar_list_permission_required",
            )
        request_headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if headers:
            request_headers.update(headers)
        timeout = _CALENDAR_READ_ATTEMPT_TIMEOUT if access == "read" else 20
        async with httpx.AsyncClient(timeout=timeout) as client:
            for attempt in range(2 if access == "read" else 1):
                try:
                    response = await self._provider_request(
                        client,
                        method=method,
                        path=path,
                        access=access,
                        params=params,
                        payload=payload,
                        headers=request_headers,
                    )
                except httpx.TransportError as exc:
                    if access == "read" and attempt == 0:
                        await asyncio.sleep(0.1 + secrets.randbelow(150) / 1000)
                        # A retry may not cross disconnect or account replacement.
                        await self._check_read_binding(user_id, current)
                        continue
                    raise GoogleConnectionError(
                        "Google Calendar took too long to respond"
                        if isinstance(exc, httpx.TimeoutException)
                        else "Google Calendar is temporarily unavailable",
                        status_code=504 if isinstance(exc, httpx.TimeoutException) else 503,
                        reason_code="calendar_timeout"
                        if isinstance(exc, httpx.TimeoutException)
                        else "calendar_unavailable",
                    ) from exc
                if access == "read" or expected_binding is not None:
                    await self._check_read_binding(user_id, current)
                error_reason = self._response_error_reason(response)
                transient = (
                    response.status_code == 429
                    or response.status_code >= 500
                    or error_reason in _RATE_LIMIT_REASONS
                )
                if access == "read" and attempt == 0 and transient:
                    delay = self._read_retry_delay(response)
                    if delay is not None:
                        await asyncio.sleep(delay)
                        await self._check_read_binding(user_id, current)
                        continue
                if response.status_code == 429 or error_reason in _RATE_LIMIT_REASONS:
                    raise GoogleConnectionError(
                        "Google Calendar is rate limited",
                        status_code=429,
                        reason_code="calendar_rate_limited",
                    )
                if response.status_code == 401:
                    raise GoogleConnectionError(
                        "Google Calendar connection needs reauthorization",
                        status_code=401,
                        reason_code="calendar_reauthorization_required",
                    )
                if response.status_code == 403:
                    if error_reason == "insufficientPermissions":
                        raise GoogleConnectionError(
                            "Google Calendar permission is insufficient",
                            status_code=403,
                            reason_code="calendar_permission_required",
                        )
                    raise GoogleConnectionError(
                        "Google Calendar could not read the requested calendar",
                        status_code=502,
                        reason_code="calendar_unreadable",
                    )
                if response.status_code in {404, 410}:
                    raise GoogleConnectionError(
                        "Calendar event was not found",
                        status_code=404,
                        reason_code="calendar_not_found",
                    )
                if response.status_code == 412:
                    raise GoogleConnectionError(
                        "Calendar event changed; review it again before confirming",
                        status_code=409,
                        reason_code="calendar_connection_changed",
                    )
                if response.status_code >= 400:
                    raise GoogleConnectionError(
                        "Google Calendar request could not be completed",
                        status_code=422 if response.status_code == 400 else 502,
                        reason_code="calendar_invalid_request"
                        if response.status_code == 400
                        else "calendar_unavailable",
                    )
                if response.status_code == 204:
                    if access == "read":
                        raise self._invalid_response(
                            "provider_empty_response", received=_MISSING, reason="missing_read_body"
                        )
                    return {}
                try:
                    parsed = response.json()
                except ValueError as exc:
                    raise self._invalid_response(
                        "provider_json", expected="JSON_object", received="", reason="invalid_json"
                    ) from exc
                if not isinstance(parsed, dict):
                    raise self._invalid_response(
                        "provider_envelope", expected="object", received=parsed, reason="wrong_type"
                    )
                return parsed
        raise self._invalid_response()

    async def _provider_request(
        self,
        client: httpx.AsyncClient,
        *,
        method: str,
        path: str,
        access: Literal["read", "manage"],
        params: dict[str, Any] | None,
        payload: dict[str, Any] | None,
        headers: dict[str, str],
    ) -> httpx.Response:
        url = f"{_CALENDAR_BASE}{path}"
        if access != "read":
            return await client.request(method, url, params=params, json=payload, headers=headers)
        async with client.stream(
            method, url, params=params, json=payload, headers=headers
        ) as response:
            declared = response.headers.get("Content-Length", "")
            if declared.isdigit() and int(declared) > _CALENDAR_READ_MAX_RESPONSE_BYTES:
                raise self._invalid_response("provider_body_size", reason="response_too_large")
            body = bytearray()
            async for chunk in response.aiter_bytes(chunk_size=65536):
                if len(body) + len(chunk) > _CALENDAR_READ_MAX_RESPONSE_BYTES:
                    raise self._invalid_response("provider_body_size", reason="response_too_large")
                body.extend(chunk)
            # aiter_bytes has already decoded Content-Encoding. Rebuilding a
            # bounded response must not decode compressed content a second time.
            return httpx.Response(
                response.status_code,
                content=bytes(body),
                request=response.request,
                headers={
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() not in {"content-encoding", "content-length"}
                },
            )

    async def _check_read_binding(self, user_id: str, expected: tuple[str, ...] | None) -> None:
        if (
            await self.connections.read_grant_binding(user_id=user_id, service="calendar")
            != expected
        ):
            raise GoogleConnectionError(
                "Google Calendar connection changed",
                status_code=409,
                reason_code="calendar_connection_changed",
            )

    @staticmethod
    def _response_error_reason(response: httpx.Response) -> str:
        if response.status_code < 400:
            return ""
        try:
            errors = response.json().get("error", {}).get("errors", [])
            if isinstance(errors, list):
                reasons = [
                    str(item.get("reason") or "") for item in errors if isinstance(item, dict)
                ]
                return next(
                    (value for value in reasons if value in _RATE_LIMIT_REASONS),
                    reasons[0] if reasons else "",
                )
        except (ValueError, AttributeError, TypeError):
            pass
        return ""

    @staticmethod
    def _read_retry_delay(response: httpx.Response) -> float | None:
        """Respect a short Retry-After; a long backoff belongs to a later request."""
        value = response.headers.get("Retry-After")
        if value:
            try:
                delay = float(value)
            except ValueError:
                try:
                    retry_at = parsedate_to_datetime(value)
                    delay = (retry_at - datetime.now(UTC)).total_seconds()
                except (ValueError, TypeError, OverflowError):
                    return None
            return max(0.0, delay) if 0 <= delay <= 1.0 else None
        return 0.1 + secrets.randbelow(150) / 1000

    @staticmethod
    def _invalid_response(
        stage: str = "provider_response",
        *,
        field_path: str = "$",
        expected: str = "valid_response",
        received: object = _MISSING,
        reason: str = "invalid_response",
    ) -> GoogleConnectionError:
        # Only code-authored paths/types/reasons: never payload values or IDs.
        received_type = (
            "missing"
            if received is _MISSING
            else "null"
            if received is None
            else "object"
            if isinstance(received, dict)
            else "array"
            if isinstance(received, list)
            else "string"
            if isinstance(received, str)
            else "boolean"
            if isinstance(received, bool)
            else "number"
            if isinstance(received, (int, float))
            else "unknown"
        )
        logger.warning(
            "calendar.response.invalid request_id=%s stage=%s field_path=%s expected=%s received=%s reason=%s",
            get_trace_id(),
            stage.replace("_", "."),
            field_path,
            expected,
            received_type,
            reason,
        )
        return GoogleConnectionError(
            "Calendar availability could not be checked",
            status_code=502,
            reason_code="calendar_invalid_response",
        )

    @classmethod
    def _freebusy_errors(cls, errors: object, *, field_path: str = "$.calendars.*.errors") -> None:
        """Preserve safe provider reasons without logging calendar IDs or payloads."""
        if errors is None or errors == []:
            return
        if not isinstance(errors, list):
            raise cls._invalid_response(
                "freebusy_errors_shape",
                field_path=field_path,
                expected="array",
                received=errors,
                reason="wrong_type",
            )
        for item in errors:
            if not isinstance(item, dict):
                raise cls._invalid_response(
                    "freebusy_errors_shape",
                    field_path=f"{field_path}[]",
                    expected="object",
                    received=item,
                    reason="wrong_type",
                )
            if not isinstance(item.get("reason"), str):
                raise cls._invalid_response(
                    "freebusy_errors_shape",
                    field_path=f"{field_path}[].reason",
                    expected="string",
                    received=item.get("reason", _MISSING),
                    reason="wrong_type",
                )
        known = {
            "notFound",
            "forbidden",
            "internalError",
            "groupTooBig",
            "tooManyCalendarsRequested",
            *_RATE_LIMIT_REASONS,
        }
        reasons = {
            item.get("reason")
            if isinstance(item.get("reason"), str) and item.get("reason") in known
            else "unknown"
            for item in errors
        }
        logger.warning(
            "calendar.freebusy.partial_failure request_id=%s reasons=%s",
            get_trace_id(),
            ",".join(sorted(reasons)),
        )
        if reasons and reasons <= (_RATE_LIMIT_REASONS | {"internalError"}):
            raise GoogleConnectionError(
                "Google could not check every calendar. Try again shortly.",
                status_code=503,
                reason_code="calendar_provider_unavailable",
            )
        raise GoogleConnectionError(
            "Availability could not be checked because Google cannot read an included calendar. "
            "Check access to your calendars in Google Calendar, then retry.",
            status_code=502,
            reason_code="calendar_unreadable",
        )

    @classmethod
    def _read_window(cls, start_at: str, end_at: str) -> tuple[str, str]:
        start, end = cls._iso(start_at), cls._iso(end_at)
        if datetime.fromisoformat(start.replace("Z", "+00:00")) >= datetime.fromisoformat(
            end.replace("Z", "+00:00")
        ):
            raise GoogleConnectionError(
                "Calendar end must be after start",
                status_code=422,
                reason_code="calendar_invalid_request",
            )
        return start, end

    @staticmethod
    def _event_summary(event: dict[str, Any]) -> dict[str, Any]:
        conference_data = _mapping(event.get("conferenceData"))
        meeting = _event_meeting(event)
        conference_request = _mapping(conference_data.get("createRequest"))
        conference_status = _mapping(conference_request.get("status"))
        return {
            "id": event.get("id"),
            "etag": event.get("etag"),
            "title": event.get("summary") or "Untitled event",
            "description": event.get("description") or None,
            "location": event.get("location") or None,
            "start": event.get("start"),
            "end": event.get("end"),
            "status": event.get("status"),
            "event_type": event.get("eventType"),
            "organizer": event.get("organizer"),
            "can_decline": not _mapping(event.get("organizer")).get("self")
            and not event.get("attendeesOmitted")
            and any(
                isinstance(item, dict) and item.get("self") and not item.get("organizer")
                for item in event.get("attendees", [])
            ),
            "attendees": [
                {
                    "email": item.get("email"),
                    "response_status": item.get("responseStatus"),
                    "display_name": item.get("displayName"),
                    "self": item.get("self") is True,
                }
                for item in event.get("attendees", [])
                if isinstance(item, dict)
            ],
            "html_link": event.get("htmlLink"),
            "conference_id": (
                _mapping(event.get("conferenceData")).get("conferenceId")
                if _mapping(
                    _mapping(_mapping(event.get("conferenceData")).get("conferenceSolution")).get(
                        "key"
                    )
                ).get("type")
                == "hangoutsMeet"
                else None
            ),
            "artifact_refs": [
                {"file_id": item["fileId"], "mime_type": item.get("mimeType")}
                for item in (event.get("attachments") or [])
                if isinstance(item, dict) and isinstance(item.get("fileId"), str)
            ],
            "conference_url": meeting[0] if meeting else None,
            "conference_name": meeting[1] if meeting else None,
            "conference_status": conference_status.get("statusCode") or None,
            "conference_provider": _mapping(conference_data.get("conferenceSolution")).get("name"),
            "conference_type": _mapping(
                _mapping(conference_data.get("conferenceSolution")).get("key")
            ).get("type"),
            "color_id": event.get("colorId"),
            "transparency": event.get("transparency"),
            "ical_uid": event.get("iCalUID"),
            "attendees_omitted": event.get("attendeesOmitted") is True,
            "recurrence_master": bool(event.get("recurrence")),
            "recurring_event_id": event.get("recurringEventId"),
            "original_start_time": event.get("originalStartTime"),
            "updated": event.get("updated"),
        }

    async def list_calendars(
        self,
        *,
        user_id: str,
        max_results: int = 50,
        page_token: str | None = None,
        expected_binding: tuple[str, ...] | None = None,
        include_hidden_invitations: bool = False,
    ) -> dict[str, Any]:
        """One bounded page of the owner's subscribed calendars."""
        if page_token is not None and (not page_token or len(page_token) > 2048):
            raise GoogleConnectionError("Calendar page is invalid", status_code=422)
        params: dict[str, Any] = {"maxResults": max(1, min(int(max_results), EVENT_PAGE_MAX))}
        if page_token:
            params["pageToken"] = page_token
        response = await self._request(
            user_id=user_id,
            method="GET",
            path="/users/me/calendarList",
            access="read",
            params=params,
            required_scope=CALENDAR_LIST_READ_SCOPE,
            expected_binding=expected_binding,
        )
        items = response.get("items", [])
        if not isinstance(items, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]
            for item in items
        ):
            raise GoogleConnectionError(
                "Calendar list is unavailable",
                status_code=502,
                reason_code="calendar_invalid_response",
            )
        calendars = [
            {
                "id": item.get("id"),
                "name": item.get("summaryOverride") or item.get("summary") or "Untitled calendar",
                "primary": item.get("primary") is True,
                "access_role": item.get("accessRole"),
                "time_zone": item.get("timeZone"),
                **{
                    name: value
                    for name, source, value in (
                        ("location", "location", item.get("location") or None),
                        ("color_id", "colorId", item.get("colorId")),
                        (
                            "background_color",
                            "backgroundColor",
                            _provider_color(item.get("backgroundColor")),
                        ),
                        (
                            "foreground_color",
                            "foregroundColor",
                            _provider_color(item.get("foregroundColor")),
                        ),
                        ("selected", "selected", item.get("selected") is True),
                        ("hidden", "hidden", item.get("hidden") is True),
                    )
                    if source in item
                },
            }
            for item in items
            if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]
        ]
        next_token = response.get("nextPageToken")
        return {
            "calendars": calendars,
            "returned_count": len(calendars),
            "truncated": bool(next_token),
            **({"next_page_token": next_token} if isinstance(next_token, str) else {}),
        }

    async def event_colors(
        self, *, user_id: str, expected_binding: tuple[str, ...] | None = None
    ) -> dict[str, str]:
        """Resolve provider event-color overrides without inventing a palette."""
        response = await self._request(
            user_id=user_id,
            method="GET",
            path="/colors",
            access="read",
            required_scope=CALENDAR_LIST_READ_SCOPE,
            **({"expected_binding": expected_binding} if expected_binding is not None else {}),
        )
        palette = response.get("event")
        if not isinstance(palette, dict) or not 1 <= len(palette) <= 256:
            raise self._invalid_response()
        colors: dict[str, str] = {}
        for identifier, definition in palette.items():
            if not isinstance(identifier, str) or not identifier or len(identifier) > 32:
                raise self._invalid_response()
            if not isinstance(definition, dict):
                raise self._invalid_response()
            color = _provider_color(definition.get("background"))
            if color is None or (
                "foreground" in definition and _provider_color(definition["foreground"]) is None
            ):
                raise self._invalid_response()
            colors[identifier] = color
        return colors

    async def invitations(
        self,
        *,
        user_id: str,
        time_zone: str,
        start_at: str | None = None,
        end_at: str | None = None,
        selected_calendar_id: str | None = None,
        selected_event_id: str | None = None,
    ) -> dict[str, Any]:
        """Reuse attendance reads with this exact Calendar grant authority."""
        from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService

        return await CalendarScheduleService(calendar=self).invitations(
            user_id=user_id,
            time_zone=time_zone,
            start_at=start_at,
            end_at=end_at,
            selected_calendar_id=selected_calendar_id,
            selected_event_id=selected_event_id,
        )

    async def list_events(
        self,
        *,
        user_id: str,
        start_at: str,
        end_at: str,
        max_results: int = 50,
        query: str | None = None,
        calendar_id: str = "primary",
        page_token: str | None = None,
        expected_binding: tuple[str, ...] | None = None,
        include_hidden_invitations: bool = False,
    ) -> dict[str, Any]:
        """One bounded page of primary-calendar events, honest about truncation.

        ``truncated`` is true when Google reports a next page: more matching
        events exist than were returned, so the caller must not claim the list
        is complete.
        """
        start, end = self._read_window(start_at, end_at)
        if not calendar_id or len(calendar_id) > 1024:
            raise GoogleConnectionError("Calendar selection is invalid", status_code=422)
        if page_token is not None and (not page_token or len(page_token) > 2048):
            raise GoogleConnectionError("Calendar page is invalid", status_code=422)
        params: dict[str, Any] = {
            "timeMin": start,
            "timeMax": end,
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": max(1, min(int(max_results), EVENT_PAGE_MAX)),
        }
        if include_hidden_invitations:
            params["showHiddenInvitations"] = "true"
        search = " ".join(str(query or "").split())
        if len(search) > _EVENT_QUERY_MAX_CHARS:
            raise GoogleConnectionError("Calendar search text is too long", status_code=422)
        if search:
            params["q"] = search
        if page_token:
            params["pageToken"] = page_token
        response = await self._request(
            user_id=user_id,
            method="GET",
            path=f"/calendars/{quote(calendar_id, safe='')}/events",
            access="read",
            params=params,
            expected_binding=expected_binding,
        )
        items = response.get("items")
        if "items" not in response and response.get("kind") == "calendar#events":
            items = []
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise GoogleConnectionError(
                "Calendar events are unavailable",
                status_code=502,
                reason_code="calendar_invalid_response",
            )
        events = [
            {**self._event_summary(item), "calendar_id": calendar_id}
            for item in items
            if isinstance(item, dict)
        ]
        next_token = response.get("nextPageToken")
        truncated = bool(next_token)
        return {
            "events": events,
            "calendar_id": calendar_id,
            "time_zone": response.get("timeZone"),
            "has_more": truncated,
            "returned_count": len(events),
            "truncated": truncated,
            **({"next_page_token": next_token} if isinstance(next_token, str) else {}),
            **(
                {
                    "more_events_exist": (
                        f"Only the first {len(events)} matching events are shown; more exist "
                        "in this range. Say so, and narrow the range or search to see the rest."
                    )
                }
                if truncated
                else {}
            ),
        }

    async def get_event(self, *, user_id: str, calendar_id: str, event_id: str) -> dict[str, Any]:
        """Read an exact event; IDs come from a live list or owner-provided link."""
        if not calendar_id or len(calendar_id) > 1024 or not event_id or len(event_id) > 2048:
            raise GoogleConnectionError("Calendar event selection is invalid", status_code=422)
        response = await self._request(
            user_id=user_id,
            method="GET",
            path=f"/calendars/{quote(calendar_id, safe='')}/events/{quote(event_id, safe='')}",
            access="read",
        )
        if not response.get("id"):
            raise GoogleConnectionError("Calendar event is unavailable", status_code=502)
        return {
            "calendar_id": calendar_id,
            "event": {**self._event_summary(response), "calendar_id": calendar_id},
        }

    async def freebusy(
        self,
        *,
        user_id: str,
        start_at: str,
        end_at: str,
        calendar_ids: list[str] | None = None,
        expected_binding: tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        start, end = self._read_window(start_at, end_at)
        ids = [value.strip() for value in (calendar_ids or ["primary"]) if value and value.strip()]
        if not ids or len(ids) > 20:
            raise GoogleConnectionError("Choose between one and twenty calendars", status_code=422)
        response = await self._request(
            user_id=user_id,
            method="POST",
            path="/freeBusy",
            access="read",
            payload={"timeMin": start, "timeMax": end, "items": [{"id": value} for value in ids]},
            **({"expected_binding": expected_binding} if expected_binding is not None else {}),
        )
        calendars = response.get("calendars", _MISSING)
        groups = response.get("groups", {})
        for path, value in (("$.calendars", calendars), ("$.groups", groups)):
            if not isinstance(value, dict):
                raise self._invalid_response(
                    "freebusy_envelope",
                    field_path=path,
                    expected="object",
                    received=value,
                    reason="wrong_type",
                )
        for group in groups.values():
            if not isinstance(group, dict):
                raise self._invalid_response(
                    "freebusy_group_shape",
                    field_path="$.groups.*",
                    expected="object",
                    received=group,
                    reason="wrong_type",
                )
            self._freebusy_errors(group.get("errors"), field_path="$.groups.*.errors")
            members = group.get("calendars", _MISSING)
            if not isinstance(members, list) or any(
                not isinstance(member, str) or member not in calendars for member in members
            ):
                raise self._invalid_response(
                    "freebusy_group_members",
                    field_path="$.groups.*.calendars",
                    expected="array_of_returned_calendar_ids",
                    received=members,
                    reason="invalid_members",
                )
        if any(value not in calendars and value not in groups for value in ids):
            raise self._invalid_response(
                "freebusy_missing_calendar",
                field_path="$.calendars.*",
                expected="requested_calendar",
                reason="missing_requested_calendar",
            )
        # HTTP 200 can contain partial errors or malformed intervals. Neither
        # may be interpreted as a free slot, even when other calendars succeeded.
        self._merged_busy_intervals(
            calendars=calendars,
            range_start=datetime.fromisoformat(start.replace("Z", "+00:00")),
            range_end=datetime.fromisoformat(end.replace("Z", "+00:00")),
        )
        return {
            "time_min": start,
            "time_max": end,
            "calendars": calendars,
            "time_zone": response.get("timeZone"),
        }

    async def find_openings(
        self,
        *,
        user_id: str,
        start_at: str,
        end_at: str,
        duration_minutes: int,
        limit: int = 3,
        calendar_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """Return the earliest free slots of a requested duration.

        This deliberately does not invent working hours or preferences. The
        caller supplies the window it is willing to use; the service derives
        deterministic candidate slots from the owner's live free/busy data.
        """
        try:
            duration = int(duration_minutes)
        except (TypeError, ValueError) as exc:
            raise GoogleConnectionError(
                "Calendar duration must be a whole number of minutes", status_code=422
            ) from exc
        if not 5 <= duration <= 720:
            raise GoogleConnectionError(
                "Calendar duration must be between 5 minutes and 12 hours", status_code=422
            )
        try:
            max_slots = int(limit)
        except (TypeError, ValueError) as exc:
            raise GoogleConnectionError(
                "Calendar opening limit must be a whole number", status_code=422
            ) from exc
        if not 1 <= max_slots <= 20:
            raise GoogleConnectionError(
                "Choose between one and twenty Calendar openings", status_code=422
            )

        availability = await self.freebusy(
            user_id=user_id,
            start_at=start_at,
            end_at=end_at,
            calendar_ids=calendar_ids,
        )
        range_start = datetime.fromisoformat(availability["time_min"].replace("Z", "+00:00"))
        range_end = datetime.fromisoformat(availability["time_max"].replace("Z", "+00:00"))
        busy = self._merged_busy_intervals(
            calendars=availability.get("calendars"),
            range_start=range_start,
            range_end=range_end,
        )
        minimum = timedelta(minutes=duration)
        openings: list[dict[str, str]] = []
        cursor = range_start
        for busy_start, busy_end in [*busy, (range_end, range_end)]:
            if busy_start - cursor >= minimum:
                opening_end = cursor + minimum
                openings.append(
                    {
                        "start_at": self._utc_iso(cursor),
                        "end_at": self._utc_iso(opening_end),
                        "available_until": self._utc_iso(busy_start),
                    }
                )
                if len(openings) == max_slots:
                    break
            if busy_end > cursor:
                cursor = busy_end

        return {
            "time_min": availability["time_min"],
            "time_max": availability["time_max"],
            "time_zone": availability.get("time_zone"),
            "duration_minutes": duration,
            "openings": openings,
        }

    @classmethod
    def _merged_busy_intervals(
        cls,
        *,
        calendars: object,
        range_start: datetime,
        range_end: datetime,
    ) -> list[tuple[datetime, datetime]]:
        intervals: list[tuple[datetime, datetime]] = []
        if not isinstance(calendars, dict):
            raise cls._invalid_response(
                "freebusy_calendars_shape",
                field_path="$.calendars",
                expected="object",
                received=calendars,
                reason="wrong_type",
            )
        for calendar in calendars.values():
            if not isinstance(calendar, dict):
                raise cls._invalid_response(
                    "freebusy_calendar_shape",
                    field_path="$.calendars.*",
                    expected="object",
                    received=calendar,
                    reason="wrong_type",
                )
            cls._freebusy_errors(calendar.get("errors"))
            busy = calendar.get("busy", _MISSING)
            if not isinstance(busy, list):
                raise cls._invalid_response(
                    "freebusy_busy_shape",
                    field_path="$.calendars.*.busy",
                    expected="array",
                    received=busy,
                    reason="wrong_type",
                )
            for item in busy:
                if not isinstance(item, dict):
                    raise cls._invalid_response(
                        "freebusy_interval_shape",
                        field_path="$.calendars.*.busy[]",
                        expected="object",
                        received=item,
                        reason="wrong_type",
                    )
                parsed = []
                for field in ("start", "end"):
                    value = item.get(field, _MISSING)
                    try:
                        if not isinstance(value, str):
                            raise ValueError()
                        parsed.append(
                            datetime.fromisoformat(cls._iso(value).replace("Z", "+00:00"))
                        )
                    except (ValueError, GoogleConnectionError) as exc:
                        raise cls._invalid_response(
                            "freebusy_interval_timestamp",
                            field_path=f"$.calendars.*.busy[].{field}",
                            expected="RFC3339_string",
                            received=value,
                            reason="invalid_timestamp",
                        ) from exc
                start, end = parsed
                if end <= start:
                    raise cls._invalid_response(
                        "freebusy_interval_order",
                        field_path="$.calendars.*.busy[]",
                        expected="start_before_end",
                        received=item,
                        reason="invalid_order",
                    )
                start, end = max(start, range_start), min(end, range_end)
                if start < end:
                    intervals.append((start, end))
        intervals.sort(key=lambda interval: interval[0])
        merged: list[tuple[datetime, datetime]] = []
        for start, end in intervals:
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        return merged

    @staticmethod
    def _utc_iso(value: datetime) -> str:
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")

    async def _find_conflicts(
        self,
        *,
        user_id: str,
        start_at: str,
        end_at: str,
        exclude_event_id: str | None = None,
        expected_binding: tuple[str, ...] | None = None,
    ) -> list[dict[str, Any]]:
        """Read the exact overlapping events used to warn the owner."""
        response = await self._request(
            user_id=user_id,
            method="GET",
            path="/calendars/primary/events",
            access="manage",
            expected_binding=expected_binding,
            params={
                "timeMin": start_at,
                "timeMax": end_at,
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": 2500,
            },
        )
        return [
            self._event_summary(event)
            for event in response.get("items", [])
            if isinstance(event, dict)
            and event.get("status") != "cancelled"
            and event.get("transparency") != "transparent"
            and str(event.get("id") or "") != str(exclude_event_id or "")
        ]

    async def propose(
        self,
        *,
        user_id: str,
        action: Literal["create", "reschedule", "cancel"],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        await self._purge_expired_proposals(user_id=user_id)
        # A create proposal previously needed no Google call, so a read-only
        # connection reached the confirmation screen and failed only after the
        # owner pressed Schedule. Verify the management grant before creating
        # any proposal so the agent can request the incremental scope instead.
        binding = await self.connections.read_grant_binding(user_id=user_id, service="calendar")
        await self.connections.access_token(
            user_id=user_id, service="calendar", access_level="manage"
        )
        if not binding:
            raise GoogleConnectionError(
                "Reconnect Calendar before reviewing a booking",
                status_code=409,
                reason_code="calendar_connection_changed",
            )
        await self._check_read_binding(user_id, binding)
        plan = self._validate_plan(action=action, payload=payload)
        plan["connection_binding"] = list(binding)
        if action == "create" and await self.connections.has_service_scope(
            user_id=user_id, service="calendar", scope=CALENDAR_LIST_READ_SCOPE
        ):
            plan["included_conflicts"] = await self._creation_conflicts(
                user_id=user_id, plan=plan, binding=binding
            )
        expected_etag: str | None = None
        if action != "create":
            event = await self._request(
                user_id=user_id,
                method="GET",
                path=f"/calendars/primary/events/{plan['event_id']}",
                access="manage",
                expected_binding=binding,
            )
            expected_etag = str(event.get("etag") or "") or None
            plan["current_event"] = self._event_summary(event)
            if action == "reschedule":
                self._stage_reschedule(plan, event)
        if action in {"create", "reschedule"}:
            plan["conflicts"] = await self._find_conflicts(
                user_id=user_id,
                start_at=plan["start_at"],
                end_at=plan["end_at"],
                exclude_event_id=plan.get("event_id"),
                expected_binding=binding,
            )
        if "included_conflicts" in plan:
            plan["primary_conflicts"] = plan["conflicts"]
            # Primary event details already warn about covered periods. Keep
            # every busy period internally for the confirmation-time comparison.
            extra = [
                busy
                for busy in plan["included_conflicts"]
                if not any(
                    self._covers_busy_period(event, busy) for event in plan["primary_conflicts"]
                )
            ]
            plan["conflicts"] = [*plan["conflicts"], *extra]
        await self._check_read_binding(user_id, binding)
        proposal_id, expires_at = await self.proposals.issue(
            user_id=user_id, action=action, plan=plan, expected_etag=expected_etag
        )
        await self._check_read_binding(user_id, binding)
        return {
            "proposal_id": proposal_id,
            "action": action,
            "expires_at": expires_at.isoformat(),
            "plan": plan,
            "confirmation_required": True,
        }

    def _validate_plan(self, *, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        event_id = str(payload.get("event_id") or "").strip()
        title = str(payload.get("title") or "").strip()
        if action in {"reschedule", "cancel"} and not event_id:
            raise GoogleConnectionError("Calendar event id is required", status_code=422)
        if action == "cancel":
            return {"event_id": event_id, "send_updates": bool(payload.get("send_updates", True))}
        # A reschedule changes only what it names; the current title stands.
        if (action == "create" and not title) or len(title) > 512:
            raise GoogleConnectionError("Calendar event title is required", status_code=422)
        start, end = (
            self._iso(str(payload.get("start_at") or "")),
            self._iso(str(payload.get("end_at") or "")),
        )
        if start >= end:
            raise GoogleConnectionError("Calendar end must be after start", status_code=422)
        raw_attendees = payload.get("attendees")
        attendees = [
            str(item).strip().lower()
            for item in (raw_attendees if isinstance(raw_attendees, list) else [])
            if str(item).strip()
        ]
        if len(attendees) > 100 or any("@" not in item for item in attendees):
            raise GoogleConnectionError(
                "Calendar attendees must be valid email addresses", status_code=422
            )
        description = str(payload.get("description") or "")[:8000]
        location = str(payload.get("location") or "")[:1024]
        plan: dict[str, Any] = {
            "event_id": event_id or None,
            "start_at": start,
            "end_at": end,
            "time_zone": str(payload.get("time_zone") or "UTC"),
            "send_updates": bool(payload.get("send_updates", True)),
        }
        if action == "create":
            return {
                **plan,
                "title": title,
                "attendees": attendees,
                "description": description,
                "location": location,
                # This id is created before the confirmation is persisted, so
                # the reviewed proposal remains the idempotency boundary for
                # Google's asynchronous conference generation request.
                "conference_request_id": f"meet_{secrets.token_urlsafe(18)}",
            }
        # Reschedule: an omitted or empty field is left exactly as it is.
        # Attendees, when given, are the complete new list; the review shows
        # who that adds and removes before anything changes.
        changes = {
            "title": title,
            "description": description,
            "location": location,
        }
        plan.update({key: value for key, value in changes.items() if value})
        if attendees:
            plan["attendees"] = list(dict.fromkeys(attendees))
        return plan

    def _stage_reschedule(self, plan: dict[str, Any], event: dict[str, Any]) -> None:
        """Record what the reviewed reschedule changes on the fetched event."""
        start = _mapping(event.get("start"))
        plan["all_day"] = bool(start.get("date")) and not start.get("dateTime")
        if plan["all_day"]:
            start_date, end_date = self._all_day_dates(plan)
            plan["start_date"], plan["end_date"] = start_date, end_date
        kept, added, removed = self._attendee_change(plan, event)
        plan["attendee_change"] = {
            "added": added,
            "removed": removed,
            "result_count": len(kept) + len(added),
        }

    @staticmethod
    def _all_day_dates(plan: dict[str, Any]) -> tuple[str, str]:
        """Every calendar day the requested interval touches, in the owner's zone.

        An all-day event stays all-day: Google's end date is exclusive, so an
        interval ending exactly at midnight does not claim the next day.
        """
        try:
            zone = ZoneInfo(str(plan.get("time_zone") or "UTC"))
        except (ValueError, ZoneInfoNotFoundError):
            zone = ZoneInfo("UTC")
        start = datetime.fromisoformat(plan["start_at"].replace("Z", "+00:00")).astimezone(zone)
        end = datetime.fromisoformat(plan["end_at"].replace("Z", "+00:00")).astimezone(zone)
        last: date = end.date() if end.time() == datetime.min.time() else end.date() + timedelta(1)
        first = start.date()
        return first.isoformat(), max(last, first + timedelta(days=1)).isoformat()

    @staticmethod
    def _attendee_change(
        plan: dict[str, Any], event: dict[str, Any]
    ) -> tuple[list[dict[str, Any]], list[str], list[str]]:
        """Kept attendee records, added emails and removed emails.

        The owner, the organizer and booked rooms are never dropped by an
        attendee list that simply leaves them out.
        """
        current = [
            item
            for item in event.get("attendees", [])
            if isinstance(item, dict) and str(item.get("email") or "").strip()
        ]
        if "attendees" not in plan:
            return current, [], []
        wanted = [str(email).strip().lower() for email in plan["attendees"]]
        wanted_set = set(wanted)
        kept = [
            item
            for item in current
            if str(item["email"]).strip().lower() in wanted_set
            or item.get("self")
            or item.get("organizer")
            or item.get("resource")
        ]
        kept_emails = {str(item["email"]).strip().lower() for item in kept}
        added = [email for email in wanted if email not in kept_emails]
        removed = [str(item["email"]) for item in current if item not in kept]
        return kept, added, removed

    def _reschedule_patch(self, plan: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        """The events.patch body: only the fields this reschedule changes.

        events.update is a full replacement, so a body built only from the
        request erased attendees, description, location, reminders and
        conference data. events.patch leaves every unnamed field untouched
        (https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).
        """
        if plan.get("all_day"):
            body: dict[str, Any] = {
                "start": {"date": plan["start_date"]},
                "end": {"date": plan["end_date"]},
            }
        else:
            start, end = _mapping(event.get("start")), _mapping(event.get("end"))
            body = {
                "start": {
                    "dateTime": plan["start_at"],
                    "timeZone": start.get("timeZone") or plan["time_zone"],
                },
                "end": {
                    "dateTime": plan["end_at"],
                    "timeZone": end.get("timeZone") or plan["time_zone"],
                },
            }
        for field, source in (
            ("summary", "title"),
            ("description", "description"),
            ("location", "location"),
        ):
            if plan.get(source) and plan[source] != event.get(field):
                body[field] = plan[source]
        kept, added, removed = self._attendee_change(plan, event)
        if added or removed:
            # A patched array replaces the whole array, so every kept attendee
            # is sent back with its response status and options intact.
            body["attendees"] = [
                {key: value for key, value in item.items() if key in _WRITABLE_ATTENDEE_FIELDS}
                for item in kept
            ] + [{"email": email} for email in added]
        return body

    @staticmethod
    def _covers_busy_period(event, busy):
        try:

            def instant(value):
                return datetime.fromisoformat(value.replace("Z", "+00:00"))

            return instant(event["start"]["dateTime"]) <= instant(
                busy["start"]["dateTime"]
            ) and instant(event["end"]["dateTime"]) >= instant(busy["end"]["dateTime"])
        except (KeyError, TypeError, ValueError):
            return False

    async def _creation_conflicts(self, *, user_id, plan, binding):
        # Reuse the same included-calendar inventory as Schedule. A free window
        # may have changed while the owner was reviewing the booking in chat.
        from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService

        schedule = CalendarScheduleService(calendar=self)
        inventory = await schedule._included_calendars(user_id, binding=binding)
        calendars, _ = schedule._availability_selection(inventory)
        selected_ids = plan.get("availability_calendar_ids")
        if selected_ids is None:
            selected_ids = [item["id"] for item in calendars]
            # Existing short-lived proposal JSON owns the reviewed selection;
            # no new persistent preference or schema is needed.
            plan["availability_calendar_ids"] = selected_ids
        elif (
            not isinstance(selected_ids, list)
            or not selected_ids
            or any(not isinstance(value, str) for value in selected_ids)
            or len(set(selected_ids)) != len(selected_ids)
            or set(selected_ids) != {item["id"] for item in calendars}
        ):
            raise GoogleConnectionError(
                "Calendar selection changed; review the meeting again",
                status_code=409,
                reason_code="calendar_selection_changed",
            )
        start = datetime.fromisoformat(plan["start_at"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(plan["end_at"].replace("Z", "+00:00"))
        busy = await schedule._busy_intervals(
            user_id=user_id,
            start=start,
            end=end,
            calendar_ids=selected_ids,
            binding=binding,
        )
        return [
            {
                "id": f"busy:{self._utc_iso(left)}:{self._utc_iso(right)}",
                "title": "Busy time in included calendars",
                "start": {"dateTime": self._utc_iso(left)},
                "end": {"dateTime": self._utc_iso(right)},
            }
            for left, right in busy
        ]

    async def execute(self, *, user_id: str, proposal_id: str) -> dict[str, Any]:
        await self._purge_expired_proposals(user_id=user_id)
        proposal = await self.proposals.claim(user_id=user_id, proposal_id=proposal_id)
        if not proposal:
            raise GoogleConnectionError(
                "Calendar proposal expired, was already used, or needs a new review",
                status_code=409,
            )
        value_epoch = await capture_value_epoch(user_id)
        plan = proposal["plan"]
        try:
            binding = tuple(plan["connection_binding"]) if plan.get("connection_binding") else None
            if binding is not None:
                await self._check_read_binding(user_id, binding)
            action = proposal["action"]
            if action == "create" and "included_conflicts" in plan:
                if "availability_calendar_ids" not in plan:
                    raise GoogleConnectionError(
                        "Calendar selection needs a new meeting review",
                        status_code=409,
                        reason_code="calendar_selection_changed",
                    )
                self._reject_new_conflicts(
                    planned=plan["included_conflicts"],
                    current=await self._creation_conflicts(
                        user_id=user_id, plan=plan, binding=binding
                    ),
                )
            if action == "create":
                if not str(plan.get("conference_request_id") or "").strip():
                    # A proposal persisted immediately before Meet support
                    # shipped has no request id. Its proposal id is already
                    # owner-scoped and confirmation-bound, so it provides a
                    # stable idempotency key for this short compatibility path.
                    plan["conference_request_id"] = (
                        f"meet_legacy_{proposal_id.removeprefix('gcal_')}"
                    )
                self._reject_new_conflicts(
                    planned=plan.get("primary_conflicts", plan.get("conflicts")),
                    current=await self._find_conflicts(
                        user_id=user_id,
                        start_at=plan["start_at"],
                        end_at=plan["end_at"],
                        expected_binding=binding,
                    ),
                )
                response = await self._request(
                    user_id=user_id,
                    method="POST",
                    path="/calendars/primary/events",
                    access="manage",
                    expected_binding=binding,
                    params={
                        "sendUpdates": "all" if plan["send_updates"] else "none",
                        "conferenceDataVersion": 1,
                    },
                    payload=self._event_payload(plan),
                )
            else:
                current = await self._request(
                    user_id=user_id,
                    method="GET",
                    path=f"/calendars/primary/events/{plan['event_id']}",
                    access="manage",
                    expected_binding=binding,
                )
                if (
                    proposal.get("expected_event_etag")
                    and current.get("etag") != proposal["expected_event_etag"]
                ):
                    raise GoogleConnectionError(
                        "Calendar event changed; review it again before confirming", status_code=409
                    )
                if action == "reschedule":
                    self._reject_new_conflicts(
                        planned=plan.get("primary_conflicts", plan.get("conflicts")),
                        current=await self._find_conflicts(
                            user_id=user_id,
                            start_at=plan["start_at"],
                            end_at=plan["end_at"],
                            expected_binding=binding,
                            exclude_event_id=plan["event_id"],
                        ),
                    )
                headers = {"If-Match": str(current.get("etag") or "")}
                if action == "reschedule":
                    _kept, added, removed = self._attendee_change(plan, current)
                    reviewed = plan.get("attendee_change") or {}
                    if added != reviewed.get("added", []) or removed != reviewed.get("removed", []):
                        raise GoogleConnectionError(
                            "Calendar event changed; review it again before confirming",
                            status_code=409,
                        )
                    response = await self._request(
                        user_id=user_id,
                        method="PATCH",
                        path=f"/calendars/primary/events/{plan['event_id']}",
                        access="manage",
                        expected_binding=binding,
                        params={"sendUpdates": "all" if plan["send_updates"] else "none"},
                        headers=headers,
                        payload=self._reschedule_patch(plan, current),
                    )
                else:
                    await self._request(
                        user_id=user_id,
                        method="DELETE",
                        path=f"/calendars/primary/events/{plan['event_id']}",
                        access="manage",
                        expected_binding=binding,
                        params={"sendUpdates": "all" if plan["send_updates"] else "none"},
                        headers=headers,
                    )
                    response = {"id": plan["event_id"], "status": "cancelled"}
            if not isinstance(response.get("id"), str) or not response["id"].strip():
                raise GoogleConnectionError(
                    "Calendar did not confirm the event. Check Google Calendar before booking again.",
                    status_code=502,
                    reason_code="calendar_mutation_unconfirmed",
                )
            await self.proposals.finish(user_id=user_id, proposal_id=proposal_id, executed=True)
        except Exception:
            await self.proposals.finish(user_id=user_id, proposal_id=proposal_id, executed=False)
            raise

        await record_calendar_effect(
            user_id=user_id, kind="proposal", source_id=proposal_id, generation=value_epoch
        )
        # The executed transition is the Feed projection seam. Remove the
        # short-lived, content-bearing plan as before, but cleanup trouble
        # must not recast a successful Google mutation as a failed one.
        try:
            await self.proposals.forget_executed(user_id=user_id, proposal_id=proposal_id)
        except Exception:
            logger.warning("Calendar proposal cleanup failed after a confirmed action")
        return {
            "action": action,
            "event": self._event_summary(response) if response.get("id") else response,
        }

    @staticmethod
    def _reject_new_conflicts(*, planned: object, current: list[dict[str, Any]]) -> None:
        reviewed = planned if isinstance(planned, list) else []
        if GoogleCalendarService._conflict_fingerprints(reviewed) != (
            GoogleCalendarService._conflict_fingerprints(current)
        ):
            raise GoogleConnectionError(
                "Calendar availability changed; review the proposed time again before confirming",
                status_code=409,
            )

    @staticmethod
    def _conflict_fingerprints(conflicts: list[dict[str, Any]]) -> set[tuple[str, str, str, str]]:
        return {
            (
                str(event.get("id") or ""),
                str(event.get("etag") or ""),
                json.dumps(event.get("start") or {}, sort_keys=True),
                json.dumps(event.get("end") or {}, sort_keys=True),
            )
            for event in conflicts
        }

    @staticmethod
    def _event_payload(plan: dict[str, Any]) -> dict[str, Any]:
        return {
            "summary": plan["title"],
            "description": plan["description"] or None,
            "location": plan["location"] or None,
            "start": {"dateTime": plan["start_at"], "timeZone": plan["time_zone"]},
            "end": {"dateTime": plan["end_at"], "timeZone": plan["time_zone"]},
            "attendees": [{"email": email} for email in plan["attendees"]],
            "conferenceData": {
                "createRequest": {
                    "requestId": plan["conference_request_id"],
                    "conferenceSolutionKey": {"type": "hangoutsMeet"},
                }
            },
        }


_singleton: GoogleCalendarService | None = None


def calendar_reads_via_door() -> bool:
    """True only in a Hussh-hosted pod; an owner-cloud agent reads and writes Calendar itself."""
    from hushh_mcp.services.pod_google_connections import calendar_reads_via_door as via_door

    return via_door()


def get_google_calendar_service() -> GoogleCalendarService:
    """The hub's service; inside an owner-cloud agent, the one on the agent's own login."""
    global _singleton
    from hushh_mcp.services.pod_google_connections import pod_calendar_service

    local = pod_calendar_service()
    if local is not None:
        return local
    if _singleton is None:
        _singleton = GoogleCalendarService()
    return _singleton
