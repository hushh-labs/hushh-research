"""Two-party time agreement followed by the advisor's existing Calendar review."""

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from db.db_client import get_db
from hushh_mcp.services.advisor_calendar_binding import binding_hash, event_id, same_instant
from hushh_mcp.services.advisor_review_notifications import notify_counterpart
from hushh_mcp.services.advisor_review_store import (
    AdvisorReviewError,
    lock_review,
    require_accepted,
    write_meeting,
)
from hushh_mcp.services.finance_sharing_service import decoded, one
from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import GoogleConnectionError


class AdvisorMeetingService:
    def __init__(self, db=None, calendar=None):
        self.db = db or get_db()
        self.calendar = calendar or get_google_calendar_service()

    def propose_time(self, viewer, request_id, body):
        if body.startAt <= datetime.now(UTC):
            raise AdvisorReviewError("ADVISOR_MEETING_TIME_PASSED", 422)
        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            require_accepted(conn, row)
            previous = decoded(row["meeting"]) or {}
            if previous.get("status") in {"booking", "confirmed", "unknown", "retryable"}:
                raise AdvisorReviewError("ADVISOR_CHECK_CALENDAR", 409)
            value = {
                "id": str(uuid4()),
                "status": "proposed",
                "proposedBy": viewer,
                "agreedBy": [viewer],
                **body.model_dump(mode="json"),
            }
            write_meeting(conn, request_id, value)
            notify_counterpart(conn, row, viewer, source_id=f"{request_id}:meeting:{value['id']}")
            return value

    def stage(self, viewer, request_id, action, proposal_id=None):
        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            require_accepted(conn, row)
            meeting = decoded(row["meeting"]) or {}
            if action == "agree":
                if meeting.get("status") != "proposed" or meeting.get("proposedBy") == viewer:
                    raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
                meeting["agreedBy"] = sorted({*meeting["agreedBy"], viewer})
                meeting["status"] = "agreed"
                write_meeting(conn, request_id, meeting)
                return row, meeting
            if viewer != row["advisor_user_id"]:
                raise AdvisorReviewError("ADVISOR_ORGANIZER_REQUIRED", 403)
            if action == "complete":
                if meeting.get("status") != "confirmed" or datetime.fromisoformat(
                    meeting["endAt"]
                ) > datetime.now(UTC):
                    raise AdvisorReviewError("ADVISOR_MEETING_NOT_FINISHED", 409)
                meeting["status"] = "completed"
                write_meeting(conn, request_id, meeting)
            elif action == "prepare":
                if meeting.get("status") not in {"agreed", "review_ready", "retryable"}:
                    raise AdvisorReviewError("ADVISOR_TIME_AGREEMENT_REQUIRED", 409)
            elif action == "confirm":
                if (
                    meeting.get("status") != "review_ready"
                    or not proposal_id
                    or meeting.get("proposalId") != proposal_id
                ):
                    raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
                meeting["status"] = "booking"
                write_meeting(conn, request_id, meeting)
            elif action == "cancel":
                if meeting.get("status") in {"booking", "unknown", "retryable"}:
                    raise AdvisorReviewError("ADVISOR_CHECK_CALENDAR", 409)
                if meeting.get("status") not in {"confirmed", "completed"}:
                    meeting = {"status": "cancelled"}
                    write_meeting(conn, request_id, meeting)
                else:
                    meeting.update(status="booking", operation="cancel")
                    write_meeting(conn, request_id, meeting)
            elif action == "check":
                if meeting.get("status") not in {"booking", "unknown", "retryable", "confirmed"}:
                    raise AdvisorReviewError("ADVISOR_CHECK_CALENDAR", 409)
            return row, meeting

    async def act(self, viewer, request_id, body):
        row, meeting = await asyncio.to_thread(
            self.stage, viewer, request_id, body.action, body.proposalId
        )
        if body.action in {"agree", "complete"} or meeting.get("status") == "cancelled":
            return meeting
        if body.action == "prepare":
            return await self._prepare(viewer, request_id, row, meeting)
        if body.action == "check":
            return await self._check(viewer, request_id, meeting)
        try:
            await self._check_binding(viewer, meeting)
            if body.action == "cancel":
                review = await self.calendar.propose(
                    user_id=viewer,
                    action="cancel",
                    payload={"event_id": meeting["eventId"], "send_updates": True},
                )
                await self.calendar.execute(user_id=viewer, proposal_id=review["proposal_id"])
                meeting["status"] = "cancelled"
            else:
                result = await self.calendar.execute(user_id=viewer, proposal_id=body.proposalId)
                event = result.get("event") or {}
                if event.get("id") != meeting["eventId"]:
                    raise AdvisorReviewError("ADVISOR_CALENDAR_UNCONFIRMED", 503)
                meeting.update(status="confirmed", joinUrl=event.get("conference_url"))
        except Exception:
            meeting["status"] = "unknown"
            await asyncio.to_thread(self._save_result, viewer, request_id, meeting)
            raise
        await asyncio.to_thread(self._save_result, viewer, request_id, meeting)
        return meeting

    async def _check_binding(self, viewer, meeting):
        binding = await self.calendar.connections.read_grant_binding(
            user_id=viewer, service="calendar"
        )
        if not binding or binding_hash(binding) != meeting.get("calendarBinding"):
            raise AdvisorReviewError("ADVISOR_CALENDAR_ACCOUNT_CHANGED", 409)

    async def _check(self, viewer, request_id, meeting):
        await self._check_binding(viewer, meeting)
        try:
            result = await self.calendar.get_event(
                user_id=viewer, calendar_id="primary", event_id=meeting["eventId"]
            )
            await self._check_binding(viewer, meeting)
            event = result["event"]
            if event.get("status") == "cancelled":
                meeting["status"] = "cancelled"
            else:
                same_time = same_instant(
                    (event.get("start") or {}).get("dateTime"), meeting["startAt"]
                ) and same_instant((event.get("end") or {}).get("dateTime"), meeting["endAt"])
                invited = any(
                    str(item.get("email") or "").casefold() == meeting["invitationEmail"].casefold()
                    for item in event.get("attendees", [])
                )
                if event.get("id") != meeting["eventId"] or not same_time or not invited:
                    raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
                meeting.update(status="confirmed", joinUrl=event.get("conference_url"))
        except GoogleConnectionError as exc:
            if exc.status_code != 404:
                raise
            # Retrying this original event id is safe even if the timed-out
            # provider write arrives later. A new time/id is still refused.
            meeting["status"] = "cancelled" if meeting.get("operation") == "cancel" else "retryable"
        await asyncio.to_thread(self._save_result, viewer, request_id, meeting)
        return meeting

    async def _prepare(self, viewer, request_id, row, meeting):
        if datetime.fromisoformat(meeting["startAt"]) <= datetime.now(UTC):
            raise AdvisorReviewError("ADVISOR_MEETING_TIME_PASSED", 409)
        email = await asyncio.to_thread(self._email, row["owner_user_id"])
        if not email:
            raise AdvisorReviewError("ADVISOR_INVITATION_EMAIL_REQUIRED", 409)
        review = await self.calendar.propose(
            user_id=viewer,
            action="create",
            payload={
                "title": "Finance introduction",
                "start_at": meeting["startAt"],
                "end_at": meeting["endAt"],
                "time_zone": meeting["timeZone"],
                "attendees": [email],
                "send_updates": True,
                "description": "Introduction requested in Hussh. No portfolio is attached.",
                "booking_source": "advisor_review",
                "advisor_event_id": event_id(viewer, request_id, meeting["id"]),
            },
        )
        if review["plan"].get("conflicts"):
            raise AdvisorReviewError("ADVISOR_CALENDAR_CONFLICT", 409)
        selected_binding = binding_hash(review["plan"]["connection_binding"])
        if meeting.get("calendarBinding") and selected_binding != meeting["calendarBinding"]:
            raise AdvisorReviewError("ADVISOR_CALENDAR_ACCOUNT_CHANGED", 409)
        meeting.update(
            status="review_ready",
            eventId=event_id(viewer, request_id, meeting["id"]),
            calendarBinding=selected_binding,
            operation="create",
            proposalId=review["proposal_id"],
            reviewExpiresAt=review["expires_at"],
            invitationEmail=email,
        )
        await asyncio.to_thread(self._save_result, viewer, request_id, meeting)
        return meeting

    def _email(self, owner):
        with self.db.engine.connect() as conn:
            row = one(
                conn, "SELECT email FROM actor_identity_cache WHERE user_id=:uid", {"uid": owner}
            )
            return row.get("email") if row else None

    def _save_result(self, viewer, request_id, value):
        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            require_accepted(conn, row)
            current = decoded(row["meeting"]) or {}
            permitted = {
                "review_ready": {"agreed", "review_ready", "retryable"},
                "unknown": {"booking"},
                "retryable": {"booking", "unknown", "retryable"},
                "confirmed": {"booking", "unknown", "retryable", "confirmed"},
                "cancelled": {"booking", "unknown", "confirmed", "retryable", "completed"},
            }.get(value.get("status"), set())
            if current.get("id") != value.get("id") or current.get("status") not in permitted:
                raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
            write_meeting(conn, request_id, value)
