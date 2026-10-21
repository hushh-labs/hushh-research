"""Connected Calendar workspace. Live reads and narrowly reviewed attendance.

No event cache or booking authority: public links disclose only explicitly
reviewed alternatives, recheck them live, and let the organizer reply/update
its own meeting. Opaque encrypted capabilities are account/grant bound.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import ipaddress
import json
import re
import secrets
from datetime import UTC, datetime, time, timedelta
from datetime import date as local_date
from typing import Any
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.runtime_settings import get_app_runtime_settings, get_core_security_settings
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, get_gmail_delivery_service
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from hushh_mcp.services.google_calendar_service import (
    GoogleCalendarService,
    get_google_calendar_service,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.product_value_receipts import capture_value_epoch, record_calendar_effect

_READABLE_CALENDAR_ROLES = frozenset({"reader", "writer", "owner", "writerWithoutPrivateAccess"})
_INVENTORY_MAX = 100
_PAGE_MAX = 10


def _error(message: str, status: int = 422, reason: str = "calendar_invalid_request"):
    return GoogleConnectionError(message, status_code=status, reason_code=reason)


def _recipient_origin(value: str | None) -> str:
    """Emails must never carry an owner-local development link."""
    try:
        url = urlparse(value or "")
        host = (url.hostname or "").rstrip(".").lower()
        try:
            address = ipaddress.ip_address(host)
            publicly_addressed = address.is_global and not address.is_multicast
        except ValueError:
            publicly_addressed = bool(
                re.fullmatch(
                    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?",
                    host,
                )
            ) and not host.endswith((".localhost", ".local", ".internal"))
        if (
            url.scheme != "https"
            or not publicly_addressed
            or url.username is not None
            or url.password is not None
            or url.port not in (None, 443)
            or url.path not in ("", "/")
            or url.query
            or url.fragment
        ):
            raise ValueError()
    except ValueError as exc:
        raise _error(
            "A public HTTPS Calendar link must be configured before offering another time.",
            503,
            "calendar_rescheduling_unavailable",
        ) from exc
    return (value or "").rstrip("/")


def day_window(
    date: str, time_zone: str, start_time: str = "00:00", end_time: str = "24:00"
) -> tuple[datetime, datetime]:
    """Convert civil boundaries separately; a local day can be 23 or 25 hours.

    Ambiguous/nonexistent editable boundaries require correction rather than
    silently choosing one occurrence of a wall-clock time.
    """
    try:
        day, zone = local_date.fromisoformat(date), ZoneInfo(time_zone)

        def boundary(value: str, *, end: bool) -> datetime:
            if value == "24:00" and end:
                naive = datetime.combine(day + timedelta(days=1), time())
            else:
                if len(value) != 5 or value[2] != ":":
                    raise ValueError()
                clock = time.fromisoformat(value)
                naive = datetime.combine(day, clock)
            candidates = {
                naive.replace(tzinfo=zone, fold=fold).astimezone(UTC)
                for fold in (0, 1)
                if naive.replace(tzinfo=zone, fold=fold)
                .astimezone(UTC)
                .astimezone(zone)
                .replace(tzinfo=None)
                == naive
            }
            if len(candidates) != 1:
                raise ValueError(
                    "This time is skipped or repeated by daylight saving; choose another boundary."
                )
            return candidates.pop()

        start, end = boundary(start_time, end=False), boundary(end_time, end=True)
        if end <= start:
            raise ValueError("Availability end must be after start on the selected date.")
        return start, end
    except (ValueError, KeyError) as exc:
        raise _error(str(exc) or "Choose a valid date, time zone and availability window.") from exc


def local_day_window(date: str, time_zone: str) -> tuple[datetime, datetime]:
    """First instant of each civil date, including midnight offset transitions.

    Editable booking boundaries remain strict in day_window. For a full day,
    repeated midnight starts at its first occurrence; skipped midnight starts
    at the first existing local time. No fixed 24-hour duration is assumed.
    """
    try:
        day, zone = local_date.fromisoformat(date), ZoneInfo(time_zone)

        def first_instant(target):
            midnight = datetime.combine(target, time())
            candidates = sorted(
                {midnight.replace(tzinfo=zone, fold=fold).astimezone(UTC) for fold in (0, 1)}
            )
            exact = [
                instant
                for instant in candidates
                if instant.astimezone(zone).replace(tzinfo=None) == midnight
            ]
            if exact:
                return exact[0]
            # The two folds bracket the missing midnight. Find the transition
            # into the civil date, rather than shifting midnight by the gap.
            left, right = candidates[0], candidates[-1]
            while right - left > timedelta(microseconds=1):
                middle = left + (right - left) // 2
                if middle.astimezone(zone).date() < target:
                    left = middle
                else:
                    right = middle
            return right

        start, end = first_instant(day), first_instant(day + timedelta(days=1))
        if start >= end:
            raise ValueError("This local date does not exist in the selected time zone.")
        return start, end
    except (ValueError, KeyError, OverflowError) as exc:
        raise _error(str(exc) or "Choose a valid date and time zone.") from exc


class CalendarScheduleService:
    def __init__(self, *, calendar=None, db=None, mail=None):
        self.calendar = calendar or get_google_calendar_service()
        self.db = db or self.calendar.db
        self.mail = mail

    @staticmethod
    def day_window(date: str, time_zone: str, start_time="00:00", end_time="24:00"):
        return day_window(date, time_zone, start_time, end_time)

    async def _sql(self, sql, params):
        return await asyncio.to_thread(self.db.execute_raw, sql, params)

    async def today(
        self, *, user_id: str, date: str, time_zone: str, include_hidden_invitations: bool = False
    ):
        start, end = day_window(date, time_zone)
        binding = await self._read_binding(user_id)
        calendars = await self._included_calendars(user_id, binding=binding)
        unreadable = [
            {**calendar, "reason": "calendar_event_details_unavailable"}
            for calendar in calendars
            if calendar.get("access_role") not in _READABLE_CALENDAR_ROLES
        ]
        semaphore = asyncio.Semaphore(4)

        async def load(calendar):
            async with semaphore:
                return await self._day_events(
                    user_id=user_id,
                    calendar=calendar,
                    date=date,
                    start=start,
                    end=end,
                    binding=binding,
                    include_hidden_invitations=include_hidden_invitations,
                )

        tasks = [
            asyncio.create_task(load(calendar))
            for calendar in calendars
            if calendar.get("access_role") in _READABLE_CALENDAR_ROLES
        ]
        try:
            groups = await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        events = [event for group in groups for event in group]
        colors = {}
        if any(event.get("color_id") is not None for event in events):
            colors = await self.calendar.event_colors(user_id=user_id, expected_binding=binding)
            await self.calendar._check_read_binding(user_id, binding)
        for event in events:
            identifier = event.get("color_id")
            if identifier is not None:
                if not isinstance(identifier, str) or identifier not in colors:
                    raise _error(
                        "Event colors could not be checked.", 502, "calendar_invalid_response"
                    )
                event["event_color"] = colors[identifier]
            else:
                event["event_color"] = event.get("calendar_color")
        events.sort(
            key=lambda event: (
                self._event_sort_time(event, time_zone),
                event["calendar_id"],
                event["id"],
            )
        )
        await self.calendar._check_read_binding(user_id, binding)
        return {
            "events": events,
            "date": date,
            "time_zone": time_zone,
            "calendars": calendars,
            "unreadable_calendars": unreadable,
            "calendar_options": self._availability_options(calendars),
        }

    async def _day_events(
        self, *, user_id, calendar, date, start, end, binding, include_hidden_invitations=False
    ):
        # Google matches all-day dates using the source calendar's zone. Fetch
        # around both civil days, then apply the selected day's exact contract.
        action_id = "primary" if calendar.get("primary") is True else calendar["id"]
        query_start, query_end = start - timedelta(days=2), end + timedelta(days=2)
        if calendar.get("time_zone"):
            try:
                source_start, source_end = day_window(date, calendar["time_zone"])
                query_start, query_end = min(start, source_start), max(end, source_end)
            except GoogleConnectionError:
                # Some valid source zones skip/repeat midnight. Keep the broad
                # safe query; exact selected-day filtering still happens below.
                pass
        events, page, seen_pages = {}, None, set()
        for _ in range(_PAGE_MAX):
            response = await self.calendar.list_events(
                user_id=user_id,
                calendar_id=action_id,
                start_at=query_start.isoformat(),
                end_at=query_end.isoformat(),
                max_results=250,
                page_token=page,
                expected_binding=binding,
                include_hidden_invitations=include_hidden_invitations,
            )
            await self.calendar._check_read_binding(user_id, binding)
            for event in response["events"]:
                if event.get("status") == "cancelled":
                    continue
                if not isinstance(event.get("id"), str) or not event["id"]:
                    raise _error(
                        "The day's events could not be checked.", 502, "calendar_invalid_response"
                    )
                if not self._event_in_day(event, date=date, start=start, end=end):
                    continue
                events[event["id"]] = {
                    **event,
                    "calendar_id": action_id,
                    "source_calendar_id": calendar["id"],
                    "source_time_zone": calendar.get("time_zone"),
                    "calendar_name": calendar["name"],
                    "calendar_color": calendar.get("background_color"),
                    "calendar_foreground_color": calendar.get("foreground_color"),
                    "can_decline": action_id == "primary" and event.get("can_decline") is True,
                }
            page = response.get("next_page_token")
            if not page:
                if response.get("truncated"):
                    raise _error(
                        "The day's events could not be fully loaded.",
                        502,
                        "calendar_invalid_response",
                    )
                return list(events.values())
            if page in seen_pages:
                raise _error(
                    "The day's events could not be fully loaded.", 502, "calendar_invalid_response"
                )
            seen_pages.add(page)
        raise _error("Too many events to load this day. Open Google Calendar to see them all.")

    @staticmethod
    def _event_in_day(event, *, date, start, end):
        try:
            left, right = event["start"], event["end"]
            if left.get("date") and right.get("date"):
                first = local_date.fromisoformat(left["date"])
                last = local_date.fromisoformat(right["date"])
                if last <= first:
                    raise ValueError()
                return first <= local_date.fromisoformat(date) < last
            first = datetime.fromisoformat(left["dateTime"].replace("Z", "+00:00"))
            last = datetime.fromisoformat(right["dateTime"].replace("Z", "+00:00"))
            if first.tzinfo is None or last.tzinfo is None or last <= first:
                raise ValueError()
            return first < end and last > start
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            raise _error(
                "The day's events could not be checked.", 502, "calendar_invalid_response"
            ) from exc

    @staticmethod
    def _event_sort_time(event, time_zone):
        value = event["start"]
        if value.get("dateTime"):
            return datetime.fromisoformat(value["dateTime"].replace("Z", "+00:00")).timestamp()
        return datetime.combine(
            local_date.fromisoformat(value["date"]), time(), ZoneInfo(time_zone)
        ).timestamp()

    async def _read_binding(self, user_id: str):
        binding = await self.calendar.connections.read_grant_binding(
            user_id=user_id, service="calendar"
        )
        if not binding:
            raise _error(
                "Reconnect Calendar to continue.", 401, "calendar_reauthorization_required"
            )
        return binding

    async def _included_calendars(self, user_id: str, *, binding=None):
        binding = binding or await self._read_binding(user_id)
        calendars, page, seen_pages = {}, None, set()
        for _ in range(_PAGE_MAX):
            response = await self.calendar.list_calendars(
                user_id=user_id, max_results=250, page_token=page, expected_binding=binding
            )
            await self.calendar._check_read_binding(user_id, binding)
            items = response.get("calendars")
            if not isinstance(items, list) or any(
                not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]
                for item in items
            ):
                raise _error(
                    "Calendar inventory could not be checked.", 502, "calendar_invalid_response"
                )
            for item in items:
                if item["id"] in calendars:
                    raise _error(
                        "Calendar inventory could not be fully checked.",
                        502,
                        "calendar_invalid_response",
                    )
                calendars[item["id"]] = item
            if len(calendars) > _INVENTORY_MAX:
                raise _error(
                    "More than 100 calendars are connected. Calendar could not be fully checked."
                )
            page = response.get("next_page_token")
            if not page:
                if response.get("truncated") or not calendars:
                    raise _error(
                        "Calendar inventory could not be fully checked.",
                        502,
                        "calendar_invalid_response",
                    )
                return list(calendars.values())
            if page in seen_pages:
                raise _error(
                    "Calendar inventory could not be fully checked.",
                    502,
                    "calendar_invalid_response",
                )
            seen_pages.add(page)
        raise _error(
            "Calendar inventory could not be fully checked.", 502, "calendar_invalid_response"
        )

    async def _busy_intervals(self, *, user_id, start, end, calendar_ids, binding):
        if not calendar_ids or len(calendar_ids) > _INVENTORY_MAX:
            raise _error(
                "Calendar availability could not be fully checked.",
                502,
                "calendar_invalid_response",
            )
        semaphore = asyncio.Semaphore(3)

        async def check_batch(identifiers):
            async with semaphore:
                response = await self.calendar.freebusy(
                    user_id=user_id,
                    start_at=GoogleCalendarService._utc_iso(start),
                    end_at=GoogleCalendarService._utc_iso(end),
                    calendar_ids=identifiers,
                    expected_binding=binding,
                )
                await self.calendar._check_read_binding(user_id, binding)
                calendars = response.get("calendars")
                if not isinstance(calendars, dict) or any(
                    identifier not in calendars for identifier in identifiers
                ):
                    raise _error(
                        "Availability could not be fully checked.", 502, "calendar_invalid_response"
                    )
                return calendars

        tasks = [
            asyncio.create_task(check_batch(calendar_ids[offset : offset + 20]))
            for offset in range(0, len(calendar_ids), 20)
        ]
        try:
            batches = await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        combined = {key: value for batch in batches for key, value in batch.items()}
        return self.calendar._merged_busy_intervals(
            calendars=combined, range_start=start, range_end=end
        )

    @staticmethod
    def _free_gaps(start, end, busy):
        gaps, cursor = [], start
        for left, right in [*busy, (end, end)]:
            if left > cursor:
                gaps.append((cursor, left))
            cursor = max(cursor, right)
        return gaps

    @staticmethod
    def _availability_options(calendars, overrides=None):
        # Google owns this exact feed namespace. Titles, access roles and
        # CalendarList.selected describe neither holiday identity nor consent
        # to block time. Unknown feeds remain included until explicitly excluded.
        overrides = overrides or {}
        options = []
        for calendar in calendars:
            default_included = not bool(
                re.fullmatch(
                    r"[a-zA-Z0-9_.-]+#holiday@group\.v\.calendar\.google\.com", calendar["id"]
                )
            )
            options.append(
                {
                    **calendar,
                    "availability_default_included": default_included,
                    "availability_included": overrides.get(calendar["id"], default_included),
                }
            )
        return options

    def _availability_selection(self, calendars, overrides=None):
        """One selection policy for Free time and confirmation-bound booking checks."""
        options = self._availability_options(calendars)
        overrides = overrides if overrides is not None else {}
        identifiers = {calendar["id"] for calendar in calendars}
        if (
            not isinstance(overrides, dict)
            or len(overrides) > _INVENTORY_MAX
            or any(
                key not in identifiers or type(value) is not bool
                for key, value in overrides.items()
            )
        ):
            error = _error(
                "Calendar selection changed. Review your calendars in settings.",
                409,
                "calendar_selection_changed",
            )
            error.calendar_options = options
            raise error
        options = self._availability_options(calendars, overrides)
        calendars = [calendar for calendar in options if calendar["availability_included"]]
        if not calendars:
            error = _error(
                "Choose at least one calendar for availability in settings.",
                422,
                "calendar_selection_empty",
            )
            error.calendar_options = options
            raise error
        return calendars, options

    async def free_windows(
        self,
        *,
        user_id,
        date,
        time_zone,
        duration_minutes,
        start_time="00:00",
        end_time="24:00",
        calendar_overrides=None,
        max_windows: int | None = 3,
    ):
        if duration_minutes not in (15, 30, 60):
            raise _error("Choose 15, 30 or 60 minutes.")
        start, end = (
            local_day_window(date, time_zone)
            if (start_time, end_time) == ("00:00", "24:00")
            else day_window(date, time_zone, start_time, end_time)
        )
        binding = await self._read_binding(user_id)
        calendars = await self._included_calendars(user_id, binding=binding)
        await self.calendar._check_read_binding(user_id, binding)
        calendars, options = self._availability_selection(calendars, calendar_overrides)
        next_minute = (datetime.now(UTC) + timedelta(minutes=1)).replace(second=0, microsecond=0)
        offer_start = min(max(start, next_minute), end)
        try:
            busy = (
                await self._busy_intervals(
                    user_id=user_id,
                    start=start,
                    end=end,
                    calendar_ids=[item["id"] for item in calendars],
                    binding=binding,
                )
                if start < end
                else []
            )
        except GoogleConnectionError as error:
            await self.calendar._check_read_binding(user_id, binding)
            # Scope selection conflicts to Free time; shared chat/voice callers
            # retain the provider service's existing unavailable status.
            if error.reason_code == "calendar_unreadable":
                error.status_code = 409
            # Owner-only selection metadata enables recovery without declaring
            # partial availability or exposing any event contents.
            if error.reason_code in {
                "calendar_unreadable",
                "calendar_invalid_response",
                "calendar_provider_unavailable",
            }:
                error.calendar_options = options
            raise
        windows = [
            {
                "start_at": GoogleCalendarService._utc_iso(left),
                "end_at": GoogleCalendarService._utc_iso(right),
                "duration_minutes": int((right - left).total_seconds() // 60),
            }
            for left, right in self._free_gaps(offer_start, end, busy)
            if right - left >= timedelta(minutes=duration_minutes)
        ]
        await self.calendar._check_read_binding(user_id, binding)
        return {
            "windows": windows if max_windows is None else windows[:max_windows],
            "full_count": len(windows),
            "requested_duration_minutes": duration_minutes,
            "calendars": calendars,
            "calendar_options": options,
            "date": date,
            "time_zone": time_zone,
            "time_min": GoogleCalendarService._utc_iso(start),
            "time_max": GoogleCalendarService._utc_iso(end),
        }

    async def availability(
        self,
        *,
        user_id: str,
        date: str,
        time_zone: str,
        start_time: str,
        end_time: str,
        duration_minutes: int,
        future_only: bool = False,
        invitation_duration: bool = False,
    ):
        if not (
            invitation_duration
            and isinstance(duration_minutes, int)
            and 1 <= duration_minutes <= 1440
        ) and duration_minutes not in (15, 30, 60):
            raise _error("Choose 15, 30 or 60 minutes.")
        start, end = day_window(date, time_zone, start_time, end_time)
        binding = await self._read_binding(user_id)
        if future_only:
            # Clamp before finding the first opening in each gap; dropping a
            # past candidate afterwards would lose the remaining free gap.
            next_minute = (datetime.now(UTC) + timedelta(minutes=1)).replace(
                second=0, microsecond=0
            )
            start = max(start, next_minute)
            if end - start < timedelta(minutes=duration_minutes):
                raise _error(
                    "No alternative times are available in this window. Choose another date or window."
                )
        calendars = await self._included_calendars(user_id, binding=binding)
        await self.calendar._check_read_binding(user_id, binding)
        calendars, _ = self._availability_selection(calendars)
        # The owning service merges overlapping busy intervals in UTC and fails
        # closed on missing/failed calendars. No client-side slot calculation.
        ids = [item["id"] for item in calendars]
        if len(ids) <= 20 and not invitation_duration:
            result = await self.calendar.find_openings(
                user_id=user_id,
                start_at=start.isoformat().replace("+00:00", "Z"),
                end_at=end.isoformat().replace("+00:00", "Z"),
                duration_minutes=duration_minutes,
                limit=20,
                calendar_ids=ids,
            )
        else:
            busy = await self._busy_intervals(
                user_id=user_id, start=start, end=end, calendar_ids=ids, binding=binding
            )
            minimum = timedelta(minutes=duration_minutes)
            result = {
                "time_min": GoogleCalendarService._utc_iso(start),
                "time_max": GoogleCalendarService._utc_iso(end),
                "duration_minutes": duration_minutes,
                "openings": [
                    {
                        "start_at": GoogleCalendarService._utc_iso(left),
                        "end_at": GoogleCalendarService._utc_iso(left + minimum),
                        "available_until": GoogleCalendarService._utc_iso(right),
                    }
                    for left, right in self._free_gaps(start, end, busy)
                    if right - left >= minimum
                ][:20],
            }
        await self.calendar._check_read_binding(user_id, binding)
        return {**result, "time_zone": time_zone, "calendars": calendars}

    @staticmethod
    def attendance_patch(event: dict[str, Any], response_status="declined", owner_email=None):
        from hushh_mcp.services.calendar_invitations import own_attendee

        if response_status not in {"accepted", "declined", "tentative"}:
            raise _error("Choose a valid invitation response.")
        organizer = event.get("organizer") or {}
        attendees = event.get("attendees") or []
        matched = own_attendee(event, owner_email, raw=True) if owner_email else None
        own = (
            [matched]
            if matched
            else (
                []
                if owner_email
                else [
                    item
                    for item in attendees
                    if item.get("self") is True and not item.get("organizer")
                ]
            )
        )
        if (
            (organizer.get("self") and not owner_email)
            or event.get("recurrence")
            or event.get("status") == "cancelled"
            or event.get("attendeesOmitted")
            or len(own) != 1
            or not own[0].get("email")
        ):
            raise _error(
                "Only your own attendance on a single invitation can be changed.",
                403,
                "calendar_attendance_forbidden",
            )
        # https://developers.google.com/workspace/calendar/api/v3/reference/events
        return {
            "attendeesOmitted": True,
            "attendees": [{"email": own[0]["email"], "responseStatus": response_status}],
        }

    @staticmethod
    def _key(purpose: str):
        secret = get_core_security_settings().app_signing_key
        if not secret:
            raise _error("Calendar review is unavailable.", 503)
        return hashlib.sha256((purpose + secret).encode()).digest()

    @classmethod
    def _seal(cls, plan: dict, purpose: str):
        nonce = secrets.token_bytes(12)
        encrypted = AESGCM(cls._key(purpose)).encrypt(
            nonce, json.dumps(plan).encode(), purpose.encode()
        )
        return base64.urlsafe_b64encode(nonce + encrypted).decode().rstrip("=")

    @classmethod
    def _open(cls, token: str, purpose: str, *, max_length: int = 40000):
        try:
            if not 40 <= len(token) <= max_length:
                raise ValueError()
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
            plan = json.loads(
                AESGCM(cls._key(purpose)).decrypt(raw[:12], raw[12:], purpose.encode())
            )
            if plan["expires"] <= datetime.now(UTC).timestamp():
                raise ValueError()
            return plan
        except Exception as exc:
            raise _error(
                "This Calendar link or review expired. Ask for a new one.",
                410,
                "calendar_review_expired",
            ) from exc

    async def invitations(self, *, user_id, **kwargs):
        from hushh_mcp.services.calendar_invitations import invitation_snapshot

        return await invitation_snapshot(self, user_id=user_id, **kwargs)

    async def _event(
        self,
        user_id: str,
        event_id: str,
        calendar_id: str,
        expected_binding=None,
        response_status="declined",
    ):
        if not calendar_id or len(calendar_id) > 1024 or not event_id or len(event_id) > 2048:
            raise _error("Choose a valid invitation.")
        if calendar_id != "primary":
            calendars = await self._included_calendars(user_id, binding=expected_binding)
            if calendar_id not in {c["id"] for c in calendars}:
                raise _error("This calendar is no longer accessible.", 403)
        event = await self.calendar._request(
            user_id=user_id,
            method="GET",
            path=f"/calendars/{quote(calendar_id, safe='')}/events/{quote(event_id, safe='')}",
            access="manage",
            expected_binding=expected_binding,
        )
        status = await self.calendar.connections.status(user_id=user_id, service="calendar")
        email = str(status.get("google_email") or "").lower()
        if not email:
            raise _error(
                "Your Calendar account could not be verified.", 403, "calendar_attendance_forbidden"
            )
        patch = self.attendance_patch(event, response_status, email)
        if not event.get("etag"):
            raise _error("The invitation could not be checked. Try again.", 502)
        return event, patch, email

    async def _invitation_conflicts(self, *, user_id, event, calendar_id, time_zone, binding):
        from hushh_mcp.services.calendar_invitations import event_bounds, occurrence_key

        calendars = await self._included_calendars(user_id, binding=binding)
        source = next(
            (
                c
                for c in calendars
                if c["id"] == calendar_id or (calendar_id == "primary" and c.get("primary"))
            ),
            {},
        )
        focus = {
            **self.calendar._event_summary(event),
            "calendar_id": calendar_id,
            "source_time_zone": source.get("time_zone") or time_zone,
        }
        start, end = event_bounds(focus, time_zone)
        snapshot = await self.invitations(
            user_id=user_id,
            start_at=start.isoformat(),
            end_at=end.isoformat(),
            time_zone=time_zone,
            binding=binding,
        )
        selected = next(
            (
                e
                for e in snapshot["events"]
                if (e["id"] == event["id"] and e["calendar_id"] == calendar_id)
                or occurrence_key(e) == occurrence_key(focus)
            ),
            None,
        )
        if selected is None:
            raise _error("This invitation changed. Load it again before responding.", 409)
        return selected["conflicts"], [c["id"] for c in snapshot["unreadable_calendars"]]

    async def _proposed_time(self, *, user_id, date, time_zone, start_time, end_time):
        """An exact proposal, never represented as a free opening when busy."""
        start, end = day_window(date, time_zone, start_time, end_time)
        if start <= datetime.now(UTC):
            raise _error("Choose a proposed time in the future.")
        binding = await self._read_binding(user_id)
        calendars = await self._included_calendars(user_id, binding=binding)
        calendars, _ = self._availability_selection(calendars)
        busy = await self._busy_intervals(
            user_id=user_id,
            start=start,
            end=end,
            calendar_ids=[item["id"] for item in calendars],
            binding=binding,
        )
        await self.calendar._check_read_binding(user_id, binding)
        return {
            "start_at": GoogleCalendarService._utc_iso(start),
            "end_at": GoogleCalendarService._utc_iso(end),
            "duration_minutes": int((end - start).total_seconds() // 60),
            "calendar_ids": [item["id"] for item in calendars],
            "conflicts": [
                {
                    "id": "busy-" + left.isoformat(),
                    "title": "Already booked",
                    "start": {"dateTime": GoogleCalendarService._utc_iso(left)},
                    "end": {"dateTime": GoogleCalendarService._utc_iso(right)},
                }
                for left, right in busy
            ],
        }

    async def review(
        self,
        *,
        user_id: str,
        event_id: str,
        calendar_id: str = "primary",
        offer_times: bool = False,
        send_message: bool = False,
        mail_only_retry: bool = False,
        exact_time: bool = False,
        message: str = "",
        date: str = "",
        time_zone: str = "UTC",
        start_time: str = "09:00",
        end_time: str = "17:00",
        duration_minutes: int = 30,
        response_status: str = "declined",
        expected_account_email: str | None = None,
    ):
        if (offer_times or send_message) and response_status != "declined":
            raise _error("Alternative-time messages require a decline response.")
        if exact_time and not offer_times:
            raise _error("An exact proposed time requires an alternative-time response.")
        if send_message and not message.strip():
            raise _error("Write a reason for declining before sending your email.")
        if mail_only_retry and (
            not send_message or offer_times or exact_time or response_status != "declined"
        ):
            raise _error(
                "An email-only retry requires a declined invitation and one reviewed note."
            )
        binding = await self._read_binding(user_id)
        event, patch, email = await self._event(
            user_id, event_id, calendar_id, binding, response_status
        )
        if expected_account_email and email.casefold() != expected_account_email.casefold():
            raise _error(
                "The connected Calendar account changed. Load this invitation again.",
                409,
                "calendar_connection_changed",
            )
        if mail_only_retry:
            attendee_email = patch["attendees"][0]["email"].casefold()
            if not any(
                str(attendee.get("email") or "").casefold() == attendee_email
                and attendee.get("responseStatus") == "declined"
                for attendee in event["attendees"]
            ):
                raise _error(
                    "This invitation is no longer declined. Review it again before sending Mail.",
                    409,
                )
        conflicts, unchecked = [], []
        if response_status == "accepted":
            conflicts, unchecked = await self._invitation_conflicts(
                user_id=user_id,
                event=event,
                calendar_id=calendar_id,
                time_zone=time_zone,
                binding=binding,
            )
        review_id = secrets.token_urlsafe(24)
        await self.calendar._check_read_binding(user_id, binding)
        plan = {
            "user_id": user_id,
            "account_id": getattr(self.calendar.connections, "account_id", "default"),
            "review_id": review_id,
            "expires": (datetime.now(UTC) + timedelta(minutes=10)).timestamp(),
            "event_id": event_id,
            "calendar_id": calendar_id,
            "response_status": response_status,
            "mail_only_retry": mail_only_retry,
            "conflicts": conflicts,
            "unchecked_calendars": unchecked,
            "time_zone": time_zone,
            "etag": event["etag"],
            "patch": patch,
            "binding": list(binding),
        }
        mail_review, link, draft, alternatives = None, None, None, []
        if offer_times or send_message:
            organizer_email = str((event.get("organizer") or {}).get("email") or "")
            if not organizer_email:
                raise _error("This invitation has no organizer email address.")
            proposed = None
            if exact_time:
                proposed = await self._proposed_time(
                    user_id=user_id,
                    date=date,
                    time_zone=time_zone,
                    start_time=start_time,
                    end_time=end_time,
                )
                conflicts = proposed["conflicts"]
                plan["conflicts"] = conflicts
                plan["proposed_calendar_ids"] = proposed["calendar_ids"]
                plan["proposed_time"] = {
                    "date": date,
                    "time_zone": time_zone,
                    "start_time": start_time,
                    "end_time": end_time,
                }
                alternatives = [
                    {key: proposed[key] for key in ("start_at", "end_at", "duration_minutes")}
                ]
            elif offer_times:
                openings = await self.availability(
                    user_id=user_id,
                    date=date,
                    time_zone=time_zone,
                    start_time=start_time,
                    end_time=end_time,
                    duration_minutes=duration_minutes,
                    future_only=True,
                    invitation_duration=True,
                )
                openings["openings"] = [
                    slot
                    for slot in openings["openings"]
                    if datetime.fromisoformat(slot["start_at"].replace("Z", "+00:00"))
                    > datetime.now(UTC)
                ]
                if not openings["openings"]:
                    raise _error(
                        "No alternative times are available in this window. Choose another date or window."
                    )
                alternatives = openings["openings"]
                origin = _recipient_origin(get_app_runtime_settings().app_frontend_origin)
                public_plan = {
                    "user_id": user_id,
                    "account_id": getattr(self.calendar.connections, "account_id", "default"),
                    "email": email,
                    "binding": list(binding),
                    "expires": (datetime.now(UTC) + timedelta(days=3)).timestamp(),
                    "openings": openings["openings"],
                    "calendar_ids": [c["id"] for c in openings["calendars"]],
                    "time_zone": time_zone,
                    "event_link": event.get("htmlLink"),
                }
                link = (
                    origin.rstrip("/")
                    + "/calendar/reschedule#"
                    + self._seal(public_plan, "calendar-public-v1")
                )
            body = (
                message.strip()
                or "I can't attend our meeting. Please choose an alternative time using the link below and update the invitation."
            )
            if proposed:
                display_zone = ZoneInfo(time_zone)
                start_label = (
                    datetime.fromisoformat(proposed["start_at"].replace("Z", "+00:00"))
                    .astimezone(display_zone)
                    .strftime("%d %b %Y, %H:%M")
                )
                end_label = (
                    datetime.fromisoformat(proposed["end_at"].replace("Z", "+00:00"))
                    .astimezone(display_zone)
                    .strftime("%d %b %Y, %H:%M")
                )
                body += f"\n\nProposed time: {start_label} – {end_label} ({time_zone}), {proposed['duration_minutes']} minutes. Please confirm and update your invitation."
            # The sealed plan binds the exact recipient and message to confirmation.
            draft = {
                "to": organizer_email,
                "subject": (
                    ("Another time for " if offer_times else "Unable to attend: ")
                    + " ".join(str(event.get("summary") or "our meeting").split())
                )[:256],
                "body": body + ("\n\n" + link if link else ""),
            }
            mail = self.mail or get_gmail_delivery_service()
            mail_review = await mail.prepare(
                user_id=user_id, draft_payload=draft, idempotency_key="calendar-" + review_id
            )
            draft["sender_token"] = mail_review["sender_token"]
            plan["mail"] = {"action_id": mail_review["action_id"], "draft": draft}
        review_token = self._seal(plan, "calendar-review-v1")
        if len(review_token) > 40000:
            raise _error(
                "The organizer note is too long for this Calendar review. Shorten it and review again.",
                422,
                "calendar_review_too_large",
            )
        await self.calendar._check_read_binding(user_id, binding)
        await self._sql("DELETE FROM calendar_attendance_reviews WHERE expires_at <= NOW()", {})
        await self._sql(
            "INSERT INTO calendar_attendance_reviews (review_id, user_id, expires_at) VALUES (:review_id, :user_id, :expires_at)",
            {
                "review_id": review_id,
                "user_id": user_id,
                "expires_at": datetime.now(UTC) + timedelta(minutes=10),
            },
        )
        await self.calendar._check_read_binding(user_id, binding)
        return {
            "review_id": review_id,
            "calendar_id": calendar_id,
            "response_status": response_status,
            "conflicts": conflicts,
            "unchecked_calendars": unchecked,
            "openings": alternatives,
            "exact_time": exact_time,
            "review_token": review_token,
            "title": event.get("summary") or "Untitled event",
            "recipient": draft["to"] if draft else None,
            "subject": draft["subject"] if draft else None,
            "message": draft["body"] if draft else None,
            "rescheduling_link": link,
            "sender_label": mail_review["sender_label"] if mail_review else None,
            "expires_at": datetime.fromtimestamp(plan["expires"], UTC).isoformat(),
        }

    async def confirm(self, *, user_id: str, review_id: str, review_token: str):
        plan = self._open(review_token, "calendar-review-v1")
        if plan["user_id"] != user_id or plan["review_id"] != review_id:
            raise _error("This review belongs to another account.", 403)
        params = {"review_id": review_id, "user_id": user_id}
        claim = await self._sql(
            "UPDATE calendar_attendance_reviews SET state = 'executing' WHERE review_id = :review_id AND user_id = :user_id AND state = 'prepared' AND expires_at > NOW() RETURNING review_id",
            params,
        )
        if not claim.data:
            current = await self._sql(
                "SELECT result_json FROM calendar_attendance_reviews WHERE review_id = :review_id AND user_id = :user_id",
                params,
            )
            if current.data and current.data[0].get("result_json"):
                result = current.data[0]["result_json"]
                return json.loads(result) if isinstance(result, str) else result
            raise _error(
                "This confirmation is in progress or expired. Check Calendar before retrying.",
                409,
                "calendar_confirmation_pending",
            )
        value_epoch = await capture_value_epoch(user_id)
        patch_attempted = False
        result = {
            "calendar": "failed",
            "email": "not_sent",
            "calendar_error": None,
            "email_error": None,
        }
        try:
            await self.calendar._check_read_binding(user_id, tuple(plan["binding"]))
            current, patch, _ = await self._event(
                user_id,
                plan["event_id"],
                plan.get("calendar_id", "primary"),
                tuple(plan["binding"]),
                plan.get("response_status", "declined"),
            )
            if current["etag"] != plan["etag"] or patch != plan["patch"]:
                raise _error("The invitation changed. Review it again before confirming.", 409)
            await self.calendar._check_read_binding(user_id, tuple(plan["binding"]))
            target_status = plan.get("response_status", "declined")
            if target_status == "accepted":
                conflicts, unchecked = await self._invitation_conflicts(
                    user_id=user_id,
                    event=current,
                    calendar_id=plan.get("calendar_id", "primary"),
                    time_zone=plan.get("time_zone", "UTC"),
                    binding=tuple(plan["binding"]),
                )
                self.calendar._reject_new_conflicts(
                    planned=plan.get("conflicts", []), current=conflicts
                )
                if set(unchecked) - set(plan.get("unchecked_calendars", [])):
                    raise _error(
                        "Calendar access changed. Review conflicts again before accepting.", 409
                    )
            if plan.get("proposed_time"):
                proposed = await self._proposed_time(user_id=user_id, **plan["proposed_time"])
                if set(proposed["calendar_ids"]) != set(plan.get("proposed_calendar_ids", [])):
                    raise _error("Included calendars changed. Review the proposed time again.", 409)
                self.calendar._reject_new_conflicts(
                    planned=plan.get("conflicts", []), current=proposed["conflicts"]
                )
            attendee_email = patch["attendees"][0]["email"].casefold()
            attendee = next(
                item
                for item in current["attendees"]
                if str(item.get("email") or "").casefold() == attendee_email
            )
            if plan.get("mail_only_retry") and attendee.get("responseStatus") != "declined":
                raise _error(
                    "This invitation is no longer declined. Review it again before sending Mail.",
                    409,
                )
            if attendee.get("responseStatus") != target_status:
                patch_attempted = True
                response = await self.calendar._request(
                    user_id=user_id,
                    method="PATCH",
                    path=f"/calendars/{quote(plan.get('calendar_id', 'primary'), safe='')}/events/{quote(plan['event_id'], safe='')}",
                    access="manage",
                    headers={"If-Match": current["etag"]},
                    params={"sendUpdates": "all"},
                    payload=patch,
                    expected_binding=tuple(plan["binding"]),
                )
                own = next(
                    (
                        item
                        for item in response.get("attendees", [])
                        if str(item.get("email") or "").casefold() == attendee_email
                    ),
                    {},
                )
                if own.get("responseStatus") != target_status:
                    result["calendar"] = "unknown"
                    raise _error(
                        "Calendar did not confirm your response. Check the invitation before retrying.",
                        502,
                    )
            result["calendar"] = target_status
        except Exception as exc:
            if (
                result["calendar"] != "unknown"
                and patch_attempted
                and (
                    not isinstance(exc, GoogleConnectionError)
                    or exc.status_code in (409, 502, 503, 504)
                )
            ):
                result["calendar"] = "unknown"
            result["calendar_error"] = (
                str(exc)
                if isinstance(exc, GoogleConnectionError)
                else "Calendar could not confirm your response."
            )
        if result["calendar"] == "declined" and plan.get("mail"):
            try:
                await self.calendar._check_read_binding(user_id, tuple(plan["binding"]))
                sent = await (self.mail or get_gmail_delivery_service()).execute(
                    user_id=user_id,
                    action_id=plan["mail"]["action_id"],
                    draft_payload=plan["mail"]["draft"],
                )
                result["email"] = "sent" if sent.get("state") == "sent" else "unknown"
                if result["email"] == "unknown":
                    result["email_error"] = (
                        "Delivery could not be confirmed. Check Sent Mail before sending again."
                    )
            except (GmailDeliveryError, GmailApiError) as exc:
                code = exc.code or ""
                result["email"] = "unknown" if "UNKNOWN" in code or "ALREADY" in code else "failed"
                result["email_error"] = str(exc)
            except Exception:
                result["email"] = "unknown"
                result["email_error"] = (
                    "Your attendance was declined, but email delivery could not be confirmed. Check Sent Mail before trying again."
                )
        await self._sql(
            "UPDATE calendar_attendance_reviews SET state = 'complete', result_json = CAST(:result AS jsonb) WHERE review_id = :review_id AND user_id = :user_id",
            {**params, "result": json.dumps(result)},
        )
        if patch_attempted and result["calendar"] in {"accepted", "declined", "tentative"}:
            await record_calendar_effect(
                user_id=user_id,
                kind="attendance",
                source_id=params["review_id"],
                generation=value_epoch,
            )
        return result

    async def public_options(self, *, token: str):
        plan = self._open(token, "calendar-public-v1")
        await self.calendar._check_read_binding(plan["user_id"], tuple(plan["binding"]))
        offered = [
            opening
            for opening in plan["openings"]
            if datetime.fromisoformat(opening["start_at"].replace("Z", "+00:00"))
            > datetime.now(UTC)
        ]
        available = []
        if offered:
            start = min(opening["start_at"] for opening in offered)
            end = max(opening["end_at"] for opening in offered)
            busy = await self._busy_intervals(
                user_id=plan["user_id"],
                start=datetime.fromisoformat(start.replace("Z", "+00:00")),
                end=datetime.fromisoformat(end.replace("Z", "+00:00")),
                calendar_ids=plan["calendar_ids"],
                binding=tuple(plan["binding"]),
            )
            for opening in offered:
                left = datetime.fromisoformat(opening["start_at"].replace("Z", "+00:00"))
                right = datetime.fromisoformat(opening["end_at"].replace("Z", "+00:00"))
                if not any(left < busy_end and right > busy_start for busy_start, busy_end in busy):
                    available.append({"start_at": opening["start_at"], "end_at": opening["end_at"]})
        await self.calendar._check_read_binding(plan["user_id"], tuple(plan["binding"]))
        return {
            "openings": available,
            "time_zone": plan["time_zone"],
            "reply_to": plan["email"],
            "event_link": plan.get("event_link"),
        }


def get_calendar_schedule_service():
    return CalendarScheduleService()
