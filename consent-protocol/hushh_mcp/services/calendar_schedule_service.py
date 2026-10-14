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

    async def today(self, *, user_id: str, date: str, time_zone: str):
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
        }

    async def _day_events(self, *, user_id, calendar, date, start, end, binding):
        # Google matches all-day dates using the source calendar's zone. Fetch
        # around both civil days, then apply the selected day's exact contract.
        action_id = "primary" if calendar.get("primary") is True else calendar["id"]
        events, page, seen_pages = {}, None, set()
        for _ in range(_PAGE_MAX):
            response = await self.calendar.list_events(
                user_id=user_id,
                calendar_id=action_id,
                start_at=(start - timedelta(days=2)).isoformat(),
                end_at=(end + timedelta(days=2)).isoformat(),
                max_results=250,
                page_token=page,
                expected_binding=binding,
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
        combined = {}
        for offset in range(0, len(calendar_ids), 20):
            response = await self.calendar.freebusy(
                user_id=user_id,
                start_at=GoogleCalendarService._utc_iso(start),
                end_at=GoogleCalendarService._utc_iso(end),
                calendar_ids=calendar_ids[offset : offset + 20],
                expected_binding=binding,
            )
            await self.calendar._check_read_binding(user_id, binding)
            calendars = response.get("calendars")
            if not isinstance(calendars, dict) or any(
                identifier not in calendars for identifier in calendar_ids[offset : offset + 20]
            ):
                raise _error(
                    "Availability could not be fully checked.", 502, "calendar_invalid_response"
                )
            combined.update(calendars)
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

    async def free_windows(
        self, *, user_id, date, time_zone, start_time, end_time, duration_minutes
    ):
        if duration_minutes not in (15, 30, 60):
            raise _error("Choose 15, 30 or 60 minutes.")
        start, end = day_window(date, time_zone, start_time, end_time)
        binding = await self._read_binding(user_id)
        calendars = await self._included_calendars(user_id, binding=binding)
        next_minute = (datetime.now(UTC) + timedelta(minutes=1)).replace(second=0, microsecond=0)
        start = min(max(start, next_minute), end)
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
        windows = [
            {
                "start_at": GoogleCalendarService._utc_iso(left),
                "end_at": GoogleCalendarService._utc_iso(right),
                "duration_minutes": int((right - left).total_seconds() // 60),
            }
            for left, right in self._free_gaps(start, end, busy)
            if right - left >= timedelta(minutes=duration_minutes)
        ]
        await self.calendar._check_read_binding(user_id, binding)
        return {
            "windows": windows[:3],
            "full_count": len(windows),
            "requested_duration_minutes": duration_minutes,
            "calendars": calendars,
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
    ):
        if duration_minutes not in (15, 30, 60):
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
        # The owning service merges overlapping busy intervals in UTC and fails
        # closed on missing/failed calendars. No client-side slot calculation.
        ids = [item["id"] for item in calendars]
        if len(ids) <= 20:
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
    def attendance_patch(event: dict[str, Any]):
        organizer = event.get("organizer") or {}
        attendees = event.get("attendees") or []
        own = [item for item in attendees if item.get("self") is True and not item.get("organizer")]
        if (
            organizer.get("self")
            or event.get("status") == "cancelled"
            or event.get("attendeesOmitted")
            or len(own) != 1
            or not own[0].get("email")
        ):
            raise _error(
                "Only your own attendance on an invitation can be declined.",
                403,
                "calendar_attendance_forbidden",
            )
        # https://developers.google.com/workspace/calendar/api/v3/reference/events
        return {
            "attendeesOmitted": True,
            "attendees": [{"email": own[0]["email"], "responseStatus": "declined"}],
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
    def _open(cls, token: str, purpose: str):
        try:
            if not 40 <= len(token) <= 40000:
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

    async def _event(self, user_id: str, event_id: str, calendar_id: str, expected_binding=None):
        # self on a shared calendar is not proof of the connected person's identity.
        if calendar_id != "primary" or not event_id or len(event_id) > 2048:
            raise _error("Decline is available for your primary Calendar invitations.", 403)
        event = await self.calendar._request(
            user_id=user_id,
            method="GET",
            path=f"/calendars/primary/events/{quote(event_id, safe='')}",
            access="manage",
            expected_binding=expected_binding,
        )
        patch = self.attendance_patch(event)
        status = await self.calendar.connections.status(user_id=user_id, service="calendar")
        email = str(status.get("google_email") or "").lower()
        organizer = event.get("organizer") or {}
        if (
            not email
            or patch["attendees"][0]["email"].lower() != email
            or str(organizer.get("email") or "").lower() == email
        ):
            raise _error(
                "Your attendance could not be verified for this invitation.",
                403,
                "calendar_attendance_forbidden",
            )
        if not event.get("etag"):
            raise _error("The invitation could not be checked. Try again.", 502)
        return event, patch, email

    async def review(
        self,
        *,
        user_id: str,
        event_id: str,
        calendar_id: str = "primary",
        offer_times: bool = False,
        message: str = "",
        date: str = "",
        time_zone: str = "UTC",
        start_time: str = "09:00",
        end_time: str = "17:00",
        duration_minutes: int = 30,
    ):
        binding = await self._read_binding(user_id)
        event, patch, email = await self._event(user_id, event_id, calendar_id, binding)
        review_id = secrets.token_urlsafe(24)
        await self.calendar._check_read_binding(user_id, binding)
        plan = {
            "user_id": user_id,
            "review_id": review_id,
            "expires": (datetime.now(UTC) + timedelta(minutes=10)).timestamp(),
            "event_id": event_id,
            "etag": event["etag"],
            "patch": patch,
            "binding": list(binding),
        }
        mail_review, link, draft = None, None, None
        if offer_times:
            organizer_email = str((event.get("organizer") or {}).get("email") or "")
            if not organizer_email:
                raise _error("This invitation has no organizer email address.")
            openings = await self.availability(
                user_id=user_id,
                date=date,
                time_zone=time_zone,
                start_time=start_time,
                end_time=end_time,
                duration_minutes=duration_minutes,
                future_only=True,
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
            origin = _recipient_origin(get_app_runtime_settings().app_frontend_origin)
            public_plan = {
                "user_id": user_id,
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
            # The exact final editable message including this link is reviewed.
            draft = {
                "to": organizer_email,
                "subject": (
                    "Another time for "
                    + " ".join(str(event.get("summary") or "our meeting").split())
                )[:256],
                "body": body + "\n\n" + link,
            }
            mail = self.mail or get_gmail_delivery_service()
            mail_review = await mail.prepare(
                user_id=user_id, draft_payload=draft, idempotency_key="calendar-" + review_id
            )
            draft["sender_token"] = mail_review["sender_token"]
            plan["mail"] = {"action_id": mail_review["action_id"], "draft": draft}
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
            "review_token": self._seal(plan, "calendar-review-v1"),
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
                user_id, plan["event_id"], "primary", tuple(plan["binding"])
            )
            if current["etag"] != plan["etag"] or patch != plan["patch"]:
                raise _error("The invitation changed. Review it again before confirming.", 409)
            await self.calendar._check_read_binding(user_id, tuple(plan["binding"]))
            attendee = next(item for item in current["attendees"] if item.get("self"))
            if attendee.get("responseStatus") != "declined":
                patch_attempted = True
                response = await self.calendar._request(
                    user_id=user_id,
                    method="PATCH",
                    path=f"/calendars/primary/events/{quote(plan['event_id'], safe='')}",
                    access="manage",
                    headers={"If-Match": current["etag"]},
                    params={"sendUpdates": "all"},
                    payload=patch,
                    expected_binding=tuple(plan["binding"]),
                )
                own = next((item for item in response.get("attendees", []) if item.get("self")), {})
                if own.get("responseStatus") != "declined":
                    result["calendar"] = "unknown"
                    raise _error(
                        "Calendar did not confirm your decline. Check the invitation before retrying.",
                        502,
                    )
            result["calendar"] = "declined"
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
