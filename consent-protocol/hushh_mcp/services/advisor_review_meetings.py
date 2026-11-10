"""Two-party time agreement followed by the advisor's existing Calendar review."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from db.db_client import get_db
from hushh_mcp.services.advisor_calendar_binding import binding_hash, event_id, same_instant
from hushh_mcp.services.advisor_review_notifications import notify_counterpart
from hushh_mcp.services.advisor_review_store import (
    AdvisorReviewError,
    lock_review,
    meeting_parts,
    public_meeting,
    require_accepted,
    write_meeting,
)
from hushh_mcp.services.finance_sharing_service import one
from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.owner_placement_guard import admit_hub_content

AUTOMATIC_APPROVAL_WINDOW = timedelta(days=1)
IN_FLIGHT_WINDOW = timedelta(minutes=2)


def _same_offer(meeting, meeting_id):
    if meeting_id != meeting.get("id"):
        raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)


def _finished(meeting):
    return datetime.fromisoformat(meeting["endAt"]) <= datetime.now(UTC)


def _introduction(meeting, past):
    return next(
        (item for item in past if item.get("status") in {"confirmed", "completed"}),
        meeting,
    )


class AdvisorMeetingService:
    def __init__(self, db=None, calendar=None):
        self.db = db or get_db()
        self.calendar = calendar or get_google_calendar_service()

    def propose_time(self, viewer, request_id, body, automatic_approval=None):
        if body.startAt <= datetime.now(UTC):
            raise AdvisorReviewError("ADVISOR_MEETING_TIME_PASSED", 422)
        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            require_accepted(conn, row)
            previous, past = meeting_parts(row)
            if "expectedMeetingId" in body.model_fields_set or previous.get("_requireMeetingId"):
                expected = str(body.expectedMeetingId) if body.expectedMeetingId else None
                _same_offer(previous, expected)
            status = previous.get("status")
            if status in {"booking", "unknown", "retryable"} or (
                status == "confirmed" and not _finished(previous)
            ):
                raise AdvisorReviewError("ADVISOR_CHECK_CALENDAR", 409)
            if automatic_approval and viewer != row["advisor_user_id"]:
                raise AdvisorReviewError("ADVISOR_ORGANIZER_REQUIRED", 403)
            if previous.get("id") and status in {"confirmed", "completed", "cancelled", "missing"}:
                past = [*past, previous]
            value = {
                "id": str(uuid4()),
                "status": "proposed",
                "proposedBy": viewer,
                "agreedBy": [viewer],
                **body.model_dump(mode="json", exclude={"expectedMeetingId"}),
            }
            if "expectedMeetingId" in body.model_fields_set:
                value["_requireMeetingId"] = True
            if automatic_approval:
                value["_automaticApproval"] = automatic_approval
            write_meeting(conn, request_id, value, past)
            notify_counterpart(conn, row, viewer, source_id=f"{request_id}:meeting:{value['id']}")
            return public_meeting(value)

    def stage(self, viewer, request_id, action, proposal_id=None, meeting_id=None):
        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            require_accepted(conn, row)
            meeting, past = meeting_parts(row)
            if action == "complete":
                if viewer != row["advisor_user_id"]:
                    raise AdvisorReviewError("ADVISOR_ORGANIZER_REQUIRED", 403)
                intro = _introduction(meeting, past)
                if meeting_id is not None or intro.get("_requireMeetingId"):
                    _same_offer(intro, meeting_id)
                if intro.get("status") != "confirmed" or not _finished(intro):
                    raise AdvisorReviewError("ADVISOR_MEETING_NOT_FINISHED", 409)
                intro["status"] = "completed"
                write_meeting(conn, request_id, meeting, past)
                return row, intro
            if meeting_id is not None or meeting.get("_requireMeetingId"):
                _same_offer(meeting, meeting_id)
            if action in {"agree", "accept_booking"}:
                if meeting.get("status") != "proposed" or meeting.get("proposedBy") == viewer:
                    raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
                if datetime.fromisoformat(meeting["startAt"]) <= datetime.now(UTC):
                    raise AdvisorReviewError("ADVISOR_MEETING_TIME_PASSED", 409)
                approval = meeting.pop("_automaticApproval", None)
                meeting["agreedBy"] = sorted({*meeting["agreedBy"], viewer})
                meeting["status"] = "agreed"
                if (
                    action == "accept_booking"
                    and viewer == row["owner_user_id"]
                    and meeting["proposedBy"] == row["advisor_user_id"]
                    and approval
                    and datetime.fromisoformat(approval["expiresAt"]) > datetime.now(UTC)
                ):
                    meeting.update(
                        status="booking",
                        operation="create",
                        calendarBinding=approval["calendarBinding"],
                        invitationEmail=approval["invitationEmail"],
                        eventId=event_id(row["advisor_user_id"], request_id, meeting["id"]),
                        _bookingStartedAt=datetime.now(UTC).isoformat(),
                        _approvalExpiresAt=approval["expiresAt"],
                    )
                write_meeting(conn, request_id, meeting, past)
                return row, meeting
            if viewer != row["advisor_user_id"]:
                raise AdvisorReviewError("ADVISOR_ORGANIZER_REQUIRED", 403)
            if action == "prepare":
                if meeting.get("status") not in {"agreed", "review_ready", "retryable"}:
                    raise AdvisorReviewError("ADVISOR_TIME_AGREEMENT_REQUIRED", 409)
            elif action == "confirm":
                if (
                    meeting.get("status") != "review_ready"
                    or not proposal_id
                    or meeting.get("proposalId") != proposal_id
                ):
                    raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
                now = datetime.now(UTC)
                if datetime.fromisoformat(meeting["startAt"]) <= now:
                    raise AdvisorReviewError("ADVISOR_MEETING_TIME_PASSED", 409)
                meeting.update(status="booking", _bookingStartedAt=now.isoformat())
                write_meeting(conn, request_id, meeting, past)
            elif action == "cancel":
                if meeting.get("status") in {"booking", "unknown", "retryable"}:
                    raise AdvisorReviewError("ADVISOR_CHECK_CALENDAR", 409)
                if meeting.get("status") == "completed" or (
                    meeting.get("status") == "confirmed" and _finished(meeting)
                ):
                    raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
                if meeting.get("status") != "confirmed":
                    meeting = {"status": "cancelled"}
                    write_meeting(conn, request_id, meeting, past)
                else:
                    meeting.update(
                        status="booking",
                        operation="cancel",
                        _bookingStartedAt=datetime.now(UTC).isoformat(),
                    )
                    write_meeting(conn, request_id, meeting, past)
            elif action == "check":
                if meeting.get("status") not in {"booking", "unknown", "retryable", "confirmed"}:
                    raise AdvisorReviewError("ADVISOR_CHECK_CALENDAR", 409)
            return row, meeting

    async def act(self, viewer, request_id, body):
        if body.action == "propose_booking":
            return await self._authorize_proposal(viewer, request_id, body.time)
        row, meeting = await asyncio.to_thread(
            self.stage,
            viewer,
            request_id,
            body.action,
            body.proposalId,
            str(body.meetingId) if body.meetingId else None,
        )
        if body.action == "accept_booking" and meeting["status"] == "booking":
            result = await self._book_accepted_offer(viewer, request_id, row, meeting)
        elif (
            body.action in {"agree", "accept_booking", "complete"}
            or meeting.get("status") == "cancelled"
        ):
            result = meeting
        elif body.action == "prepare":
            result = await self._prepare(viewer, request_id, row, meeting)
        elif body.action == "check":
            result = await self._check(viewer, request_id, meeting)
        else:
            result = await self._dispatch(viewer, request_id, body.action, meeting, body.proposalId)
        return public_meeting(result)

    async def _dispatch(
        self, viewer, request_id, action, expected, proposal_id, *, before_create=None
    ):
        meeting = dict(expected)
        manual_confirmation_rejected = False
        try:
            binding = await self._check_binding(viewer, meeting)
            if action == "cancel":
                review = await self.calendar.propose(
                    user_id=viewer,
                    action="cancel",
                    expected_binding=binding,
                    payload={"event_id": meeting["eventId"], "send_updates": True},
                )
                await self.calendar.execute(user_id=viewer, proposal_id=review["proposal_id"])
                meeting["status"] = "cancelled"
                meeting.pop("joinUrl", None)
            else:

                async def verify_manual_confirmation():
                    nonlocal manual_confirmation_rejected
                    try:
                        await self._require_shared_organizer(viewer)
                        row = await asyncio.to_thread(
                            self._accepted_review, viewer, request_id, expected
                        )
                        if datetime.fromisoformat(expected["startAt"]) <= datetime.now(UTC):
                            raise AdvisorReviewError("ADVISOR_MEETING_TIME_PASSED", 409)
                        if (
                            await asyncio.to_thread(self._email, row["owner_user_id"])
                            != expected["invitationEmail"]
                        ):
                            raise AdvisorReviewError("ADVISOR_INVITATION_EMAIL_REQUIRED", 409)
                    except AdvisorReviewError:
                        manual_confirmation_rejected = True
                        raise

                result = await self.calendar.execute(
                    user_id=viewer,
                    proposal_id=proposal_id,
                    before_create=before_create or verify_manual_confirmation,
                )
                event = result.get("event") or {}
                if event.get("id") != meeting["eventId"]:
                    raise AdvisorReviewError("ADVISOR_CALENDAR_UNCONFIRMED", 503)
                meeting.update(status="confirmed", joinUrl=event.get("conference_url"))
        except Exception:
            meeting["status"] = "agreed" if manual_confirmation_rejected else "unknown"
            await asyncio.to_thread(self._save_result, viewer, request_id, meeting, expected)
            raise
        await asyncio.to_thread(self._save_result, viewer, request_id, meeting, expected)
        return meeting

    def _accepted_review(self, viewer, request_id, expected=None):
        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            require_accepted(conn, row)
            if expected is not None and meeting_parts(row)[0] != expected:
                raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
            return row

    async def _require_shared_organizer(self, advisor):
        if await admit_hub_content(advisor, "advisor_calendar_booking") != "shared":
            raise AdvisorReviewError("ADVISOR_CONNECT_CALENDAR", 409)

    async def _authorize_proposal(self, viewer, request_id, body):
        row = await asyncio.to_thread(self._accepted_review, viewer, request_id)
        if viewer != row["advisor_user_id"]:
            raise AdvisorReviewError("ADVISOR_ORGANIZER_REQUIRED", 403)
        await self._require_shared_organizer(viewer)
        binding = await self.calendar.connections.read_grant_binding(
            user_id=viewer, service="calendar"
        )
        if not binding:
            raise AdvisorReviewError("ADVISOR_CONNECT_CALENDAR", 409)
        await self.calendar.connections.access_token(
            user_id=viewer, service="calendar", access_level="manage"
        )
        email = await asyncio.to_thread(self._email, row["owner_user_id"])
        if not email:
            raise AdvisorReviewError("ADVISOR_INVITATION_EMAIL_REQUIRED", 409)
        expires = min(body.startAt, datetime.now(UTC) + AUTOMATIC_APPROVAL_WINDOW)
        approval = {
            "calendarBinding": binding_hash(binding),
            "invitationEmail": email,
            "expiresAt": expires.isoformat(),
        }
        return await asyncio.to_thread(self.propose_time, viewer, request_id, body, approval)

    async def _book_accepted_offer(self, viewer, request_id, row, meeting):
        advisor = row["advisor_user_id"]

        async def verify_approval():
            await self._require_shared_organizer(advisor)
            await asyncio.to_thread(self._accepted_review, advisor, request_id, meeting)
            if await asyncio.to_thread(self._email, viewer) != meeting["invitationEmail"]:
                raise AdvisorReviewError("ADVISOR_INVITATION_EMAIL_REQUIRED", 409)
            if datetime.fromisoformat(meeting["_approvalExpiresAt"]) <= datetime.now(UTC):
                raise AdvisorReviewError("ADVISOR_MEETING_REVIEW_REQUIRED", 409)
            return await self._check_binding(advisor, meeting)

        try:
            binding = await verify_approval()
            review = await self._calendar_proposal(
                advisor, request_id, meeting, meeting["invitationEmail"], binding=binding
            )
        except Exception:
            # No create was dispatched. The advisor can review this accepted time again.
            agreed = {
                key: value
                for key, value in meeting.items()
                if key not in {"operation", "calendarBinding", "invitationEmail", "eventId"}
            }
            agreed["status"] = "agreed"
            await asyncio.to_thread(self._save_result, advisor, request_id, agreed, meeting)
            raise

        async def before_create():
            await verify_approval()

        return await self._dispatch(
            advisor,
            request_id,
            "confirm",
            meeting,
            review["proposal_id"],
            before_create=before_create,
        )

    async def _check_binding(self, viewer, meeting):
        binding = await self.calendar.connections.read_grant_binding(
            user_id=viewer, service="calendar"
        )
        if not binding or binding_hash(binding) != meeting.get("calendarBinding"):
            raise AdvisorReviewError("ADVISOR_CALENDAR_ACCOUNT_CHANGED", 409)
        return binding

    async def _check(self, viewer, request_id, expected):
        meeting = dict(expected)
        await self._check_binding(viewer, meeting)
        started = meeting.get("_bookingStartedAt")
        if (
            meeting["status"] == "booking"
            and started
            and (datetime.now(UTC) < datetime.fromisoformat(started) + IN_FLIGHT_WINDOW)
        ):
            return meeting
        try:
            result = await self.calendar.get_event(
                user_id=viewer, calendar_id="primary", event_id=meeting["eventId"]
            )
            await self._check_binding(viewer, meeting)
            event = result["event"]
            if event.get("id") != meeting["eventId"]:
                raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
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
                if not same_time or not invited:
                    raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
                meeting.update(status="confirmed", joinUrl=event.get("conference_url"))
        except GoogleConnectionError as exc:
            if exc.status_code not in {404, 410}:
                raise
            await self._check_binding(viewer, meeting)
            if meeting.get("operation") == "cancel":
                meeting["status"] = "cancelled"
            else:
                meeting["status"] = "missing" if meeting["status"] == "confirmed" else "retryable"
        if meeting["status"] in {"missing", "cancelled"}:
            meeting.pop("joinUrl", None)
        await asyncio.to_thread(self._save_result, viewer, request_id, meeting, expected)
        return meeting

    async def _prepare(self, viewer, request_id, row, expected):
        meeting = dict(expected)
        if datetime.fromisoformat(meeting["startAt"]) <= datetime.now(UTC):
            raise AdvisorReviewError("ADVISOR_MEETING_TIME_PASSED", 409)
        email = await asyncio.to_thread(self._email, row["owner_user_id"])
        if not email:
            raise AdvisorReviewError("ADVISOR_INVITATION_EMAIL_REQUIRED", 409)
        review = await self._calendar_proposal(viewer, request_id, meeting, email)
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
        await asyncio.to_thread(self._save_result, viewer, request_id, meeting, expected)
        return meeting

    async def _calendar_proposal(self, viewer, request_id, meeting, email, *, binding=None):
        review = await self.calendar.propose(
            user_id=viewer,
            action="create",
            expected_binding=binding,
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
        return review

    def _email(self, owner):
        with self.db.engine.connect() as conn:
            row = one(
                conn,
                "SELECT email FROM actor_identity_cache WHERE user_id=:uid AND email_verified IS TRUE",
                {"uid": owner},
            )
            return row.get("email") if row else None

    def _save_result(self, viewer, request_id, value, expected):
        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            require_accepted(conn, row)
            current, past = meeting_parts(row)
            if current != expected:
                raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 409)
            if value.get("status") != "booking":
                value.pop("_bookingStartedAt", None)
                value.pop("_approvalExpiresAt", None)
            write_meeting(conn, request_id, value, past)
