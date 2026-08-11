"""Live Google Calendar reads and confirmation-bound mutations.

Calendar contents are fetched from Google when needed. Only short-lived action
plans are stored locally; the service does not turn events into PKM or a
long-lived cache.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import httpx

from db.db_client import get_db
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
    get_google_connection_service,
)

_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"


class GoogleCalendarService:
    def __init__(
        self, *, db: Any | None = None, connections: GoogleConnectionService | None = None
    ) -> None:
        self.db = db or get_db()
        self.connections = connections or get_google_connection_service()

    def _purge_expired_proposals(self, *, user_id: str) -> None:
        """Remove terminal and expired plans on the next Calendar mutation.

        The proposal table is a confirmation hand-off, not a Calendar cache or
        audit log. PostgreSQL is the current shared cleanup seam; a scheduled
        Redis/outbox retention worker can perform the same bounded delete on a
        schedule later.
        """
        self.db.execute_raw(
            """DELETE FROM google_calendar_action_proposals
               WHERE user_id = :user_id
                 AND (expires_at <= NOW() OR status IN ('executed', 'failed', 'expired'))""",
            {"user_id": user_id},
        )

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
    ) -> dict[str, Any]:
        token = await self.connections.access_token(
            user_id=user_id, service="calendar", access_level=access
        )
        request_headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if headers:
            request_headers.update(headers)
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.request(
                method,
                f"{_CALENDAR_BASE}{path}",
                params=params,
                json=payload,
                headers=request_headers,
            )
        if response.status_code == 401:
            raise GoogleConnectionError(
                "Google Calendar connection needs reauthorization", status_code=401
            )
        if response.status_code == 403:
            raise GoogleConnectionError(
                "Google Calendar permission is insufficient", status_code=403
            )
        if response.status_code == 404:
            raise GoogleConnectionError("Calendar event was not found", status_code=404)
        if response.status_code == 412:
            raise GoogleConnectionError(
                "Calendar event changed; review it again before confirming", status_code=409
            )
        if response.status_code >= 400:
            raise GoogleConnectionError(
                "Google Calendar request could not be completed", status_code=502
            )
        if response.status_code == 204:
            return {}
        parsed = response.json()
        return parsed if isinstance(parsed, dict) else {}

    @staticmethod
    def _event_summary(event: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": event.get("id"),
            "etag": event.get("etag"),
            "title": event.get("summary") or "Untitled event",
            "description": event.get("description") or None,
            "location": event.get("location") or None,
            "start": event.get("start"),
            "end": event.get("end"),
            "status": event.get("status"),
            "attendees": [
                {"email": item.get("email"), "response_status": item.get("responseStatus")}
                for item in event.get("attendees", [])
                if isinstance(item, dict)
            ],
            "html_link": event.get("htmlLink"),
            "updated": event.get("updated"),
        }

    async def list_events(
        self, *, user_id: str, start_at: str, end_at: str, max_results: int = 50
    ) -> dict[str, Any]:
        start, end = self._iso(start_at), self._iso(end_at)
        if start >= end:
            raise GoogleConnectionError("Calendar end must be after start", status_code=422)
        response = await self._request(
            user_id=user_id,
            method="GET",
            path="/calendars/primary/events",
            access="read",
            params={
                "timeMin": start,
                "timeMax": end,
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": max(1, min(max_results, 100)),
            },
        )
        return {
            "events": [
                self._event_summary(item)
                for item in response.get("items", [])
                if isinstance(item, dict)
            ],
            "time_zone": response.get("timeZone"),
        }

    async def freebusy(
        self, *, user_id: str, start_at: str, end_at: str, calendar_ids: list[str] | None = None
    ) -> dict[str, Any]:
        start, end = self._iso(start_at), self._iso(end_at)
        if start >= end:
            raise GoogleConnectionError("Calendar end must be after start", status_code=422)
        ids = [value.strip() for value in (calendar_ids or ["primary"]) if value and value.strip()]
        if not ids or len(ids) > 20:
            raise GoogleConnectionError("Choose between one and twenty calendars", status_code=422)
        response = await self._request(
            user_id=user_id,
            method="POST",
            path="/freeBusy",
            access="read",
            payload={"timeMin": start, "timeMax": end, "items": [{"id": value} for value in ids]},
        )
        return {
            "time_min": start,
            "time_max": end,
            "calendars": response.get("calendars", {}),
            "time_zone": response.get("timeZone"),
        }

    async def propose(
        self,
        *,
        user_id: str,
        action: Literal["create", "reschedule", "cancel"],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        self._purge_expired_proposals(user_id=user_id)
        plan = self._validate_plan(action=action, payload=payload)
        expected_etag: str | None = None
        if action != "create":
            event = await self._request(
                user_id=user_id,
                method="GET",
                path=f"/calendars/primary/events/{plan['event_id']}",
                access="manage",
            )
            expected_etag = str(event.get("etag") or "") or None
            plan["current_event"] = self._event_summary(event)
        proposal_id = f"gcal_{secrets.token_urlsafe(24)}"
        self.db.execute_raw(
            """INSERT INTO google_calendar_action_proposals
               (proposal_id, user_id, action, payload_json, expected_event_etag, expires_at)
               VALUES (:proposal_id, :user_id, :action, CAST(:payload_json AS jsonb), :etag, :expires_at)""",
            {
                "proposal_id": proposal_id,
                "user_id": user_id,
                "action": action,
                "payload_json": json.dumps(plan),
                "etag": expected_etag,
                "expires_at": datetime.now(UTC) + timedelta(minutes=10),
            },
        )
        return {
            "proposal_id": proposal_id,
            "action": action,
            "expires_at": (datetime.now(UTC) + timedelta(minutes=10)).isoformat(),
            "plan": plan,
            "confirmation_required": True,
        }

    def _validate_plan(self, *, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        event_id = str(payload.get("event_id") or "").strip()
        title = str(payload.get("title") or "").strip()
        if action in {"reschedule", "cancel"} and not event_id:
            raise GoogleConnectionError("Calendar event id is required", status_code=422)
        if action in {"create", "reschedule"}:
            if not title or len(title) > 512:
                raise GoogleConnectionError("Calendar event title is required", status_code=422)
            start, end = (
                self._iso(str(payload.get("start_at") or "")),
                self._iso(str(payload.get("end_at") or "")),
            )
            if start >= end:
                raise GoogleConnectionError("Calendar end must be after start", status_code=422)
            attendees = [
                str(item).strip().lower()
                for item in payload.get("attendees", [])
                if str(item).strip()
            ]
            if len(attendees) > 100 or any("@" not in item for item in attendees):
                raise GoogleConnectionError(
                    "Calendar attendees must be valid email addresses", status_code=422
                )
            return {
                "event_id": event_id or None,
                "title": title,
                "start_at": start,
                "end_at": end,
                "time_zone": str(payload.get("time_zone") or "UTC"),
                "attendees": attendees,
                "description": str(payload.get("description") or "")[:8000],
                "location": str(payload.get("location") or "")[:1024],
                "send_updates": bool(payload.get("send_updates", True)),
            }
        return {"event_id": event_id, "send_updates": bool(payload.get("send_updates", True))}

    async def execute(self, *, user_id: str, proposal_id: str) -> dict[str, Any]:
        self._purge_expired_proposals(user_id=user_id)
        claim = self.db.execute_raw(
            """UPDATE google_calendar_action_proposals SET status = 'executing'
               WHERE proposal_id = :proposal_id AND user_id = :user_id AND status = 'pending' AND expires_at > NOW()
               RETURNING action, payload_json, expected_event_etag""",
            {"proposal_id": proposal_id, "user_id": user_id},
        )
        if not claim.data:
            raise GoogleConnectionError(
                "Calendar proposal expired, was already used, or needs a new review",
                status_code=409,
            )
        proposal = claim.data[0]
        plan = (
            proposal["payload_json"]
            if isinstance(proposal["payload_json"], dict)
            else json.loads(proposal["payload_json"])
        )
        try:
            action = proposal["action"]
            if action == "create":
                response = await self._request(
                    user_id=user_id,
                    method="POST",
                    path="/calendars/primary/events",
                    access="manage",
                    params={"sendUpdates": "all" if plan["send_updates"] else "none"},
                    payload=self._event_payload(plan),
                )
            else:
                current = await self._request(
                    user_id=user_id,
                    method="GET",
                    path=f"/calendars/primary/events/{plan['event_id']}",
                    access="manage",
                )
                if (
                    proposal.get("expected_event_etag")
                    and current.get("etag") != proposal["expected_event_etag"]
                ):
                    raise GoogleConnectionError(
                        "Calendar event changed; review it again before confirming", status_code=409
                    )
                headers = {"If-Match": str(current.get("etag") or "")}
                if action == "reschedule":
                    response = await self._request(
                        user_id=user_id,
                        method="PUT",
                        path=f"/calendars/primary/events/{plan['event_id']}",
                        access="manage",
                        params={"sendUpdates": "all" if plan["send_updates"] else "none"},
                        headers=headers,
                        payload=self._event_payload(plan),
                    )
                else:
                    await self._request(
                        user_id=user_id,
                        method="DELETE",
                        path=f"/calendars/primary/events/{plan['event_id']}",
                        access="manage",
                        params={"sendUpdates": "all" if plan["send_updates"] else "none"},
                        headers=headers,
                    )
                    response = {"id": plan["event_id"], "status": "cancelled"}
            self.db.execute_raw(
                "DELETE FROM google_calendar_action_proposals WHERE proposal_id = :proposal_id AND user_id = :user_id",
                {"proposal_id": proposal_id, "user_id": user_id},
            )
            return {
                "action": action,
                "event": self._event_summary(response) if response.get("id") else response,
            }
        except Exception:
            self.db.execute_raw(
                "UPDATE google_calendar_action_proposals SET status = 'failed' WHERE proposal_id = :proposal_id",
                {"proposal_id": proposal_id},
            )
            raise

    @staticmethod
    def _event_payload(plan: dict[str, Any]) -> dict[str, Any]:
        return {
            "summary": plan["title"],
            "description": plan["description"] or None,
            "location": plan["location"] or None,
            "start": {"dateTime": plan["start_at"], "timeZone": plan["time_zone"]},
            "end": {"dateTime": plan["end_at"], "timeZone": plan["time_zone"]},
            "attendees": [{"email": email} for email in plan["attendees"]],
        }


_singleton: GoogleCalendarService | None = None


def get_google_calendar_service() -> GoogleCalendarService:
    global _singleton
    if _singleton is None:
        _singleton = GoogleCalendarService()
    return _singleton
