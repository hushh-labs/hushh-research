"""Connected Calendar workspace APIs, separate from lifecycle/chat/setup contracts."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, StrictBool

from api.middleware import (
    require_firebase_auth,
    verify_user_id_match,
)
from api.middlewares.observability import get_request_id
from api.middlewares.rate_limit import limiter
from api.routes.one.calendar import _http
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.owner_placement_guard import (
    hub_content_firebase_read_only,
    hub_content_owner,
)

router = APIRouter(prefix="/api/one/calendar", tags=["One Calendar Workspace"])


# First-party Schedule reads use Firebase identity plus the owner-bound Google
# Calendar OAuth grant enforced by CalendarScheduleService on every provider call.
# This grants no vault, PKM, delegated-agent or attendance mutation authority.
class CalendarDay(BaseModel):
    date: str = Field(min_length=10, max_length=10)
    time_zone: str = Field(min_length=1, max_length=128)


class CalendarOpeningWindow(CalendarDay):
    start_time: str = Field(default="09:00", max_length=5)
    end_time: str = Field(default="17:00", max_length=5)
    duration_minutes: Literal[15, 30, 60] = 30


class CalendarAvailabilityWindow(CalendarDay):
    start_time: Literal["00:00"] = "00:00"
    end_time: Literal["24:00"] = "24:00"
    duration_minutes: Literal[15, 30, 60] = 30
    calendar_overrides: dict[str, StrictBool] | None = Field(default=None, max_length=100)


class CalendarAttendanceReview(CalendarDay):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    start_time: str = Field(default="09:00", max_length=5)
    end_time: str = Field(default="17:00", max_length=5)
    duration_minutes: int = Field(default=30, ge=1, le=1440)
    event_id: str = Field(min_length=1, max_length=2048)
    calendar_id: str = Field(default="primary", min_length=1, max_length=1024)
    response_status: Literal["accepted", "declined", "tentative"] = "declined"
    expected_account_email: str | None = Field(default=None, max_length=512)
    offer_times: bool = False
    send_message: StrictBool = False
    mail_only_retry: StrictBool = False
    exact_time: StrictBool = False
    message: str = Field(default="", max_length=8000)


class CalendarInvitationsWindow(BaseModel):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    selected_calendar_id: str | None = Field(default=None, max_length=1024)
    selected_event_id: str | None = Field(default=None, max_length=2048)
    start_at: str | None = Field(default=None, max_length=64)
    end_at: str | None = Field(default=None, max_length=64)
    time_zone: str = Field(default="UTC", min_length=1, max_length=128)


class CalendarAttendanceConfirm(BaseModel):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    review_id: str = Field(min_length=16, max_length=128)
    review_token: str = Field(min_length=40, max_length=40000)


class CalendarPublicOptions(BaseModel):
    token: str = Field(min_length=40, max_length=40000)


def _schedule(account_id: str = "default"):
    if account_id != "default":
        from hushh_mcp.services.calendar_account_board_service import account_schedule

        return account_schedule(account_id)
    from hushh_mcp.services.calendar_schedule_service import get_calendar_schedule_service

    return get_calendar_schedule_service()


def _selected_schedule(account_id: str):
    return _schedule() if account_id == "default" else _schedule(account_id)


class CalendarBoardDay(CalendarDay):
    duration_minutes: Literal[15, 30, 60] = 30
    calendar_overrides_by_account: dict[str, dict[str, StrictBool]] | None = Field(
        default=None, max_length=3
    )


class CalendarEventRef(BaseModel):
    account_id: str = Field(min_length=1, max_length=128)
    calendar_id: str = Field(min_length=1, max_length=1024)
    event_id: str = Field(min_length=1, max_length=2048)


class CalendarDeclineChoice(CalendarEventRef):
    message: str = Field(min_length=1, max_length=8000)


class CalendarConflictReviewRequest(CalendarDay):
    keep: CalendarEventRef
    decline: list[CalendarDeclineChoice] = Field(min_length=1, max_length=2)


class CalendarConflictConfirmRequest(BaseModel):
    review_id: str = Field(min_length=16, max_length=128)
    review_token: str = Field(min_length=40, max_length=200000)


@router.post("/board/day")
async def calendar_board_day(
    payload: CalendarBoardDay,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        from hushh_mcp.services.calendar_account_board_service import CalendarAccountBoardService

        response.headers["Cache-Control"] = "private, no-store"
        return await CalendarAccountBoardService().day(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/conflicts/review")
async def calendar_conflict_review(
    payload: CalendarConflictReviewRequest,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        from hushh_mcp.services.calendar_conflict_service import CalendarConflictService

        return await CalendarConflictService().review(
            user_id=token["user_id"], **payload.model_dump()
        )
    except (GmailDeliveryError, GmailApiError) as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "reason_code": exc.code, "message": str(exc)},
        ) from exc
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/conflicts/confirm")
async def calendar_conflict_confirm(
    payload: CalendarConflictConfirmRequest,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    try:
        from hushh_mcp.services.calendar_conflict_service import CalendarConflictService

        return await CalendarConflictService().confirm(
            user_id=token["user_id"], **payload.model_dump()
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/schedule/today")
async def schedule_today(
    payload: CalendarDay,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _schedule().today(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/schedule/availability")
async def schedule_availability(
    payload: CalendarAvailabilityWindow,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _schedule().free_windows(
            user_id=firebase_uid, **payload.model_dump(exclude_none=True)
        )
    except Exception as exc:
        # Correlate classified failures without account IDs or provider payloads.
        logging.getLogger(__name__).warning(
            "calendar.availability.failed request_id=%s reason_code=%s status=%s",
            get_request_id(),
            exc.reason_code if isinstance(exc, GoogleConnectionError) else "backend_failure",
            exc.status_code if isinstance(exc, GoogleConnectionError) else 503,
        )
        error = _http(exc)
        error.headers = {**(error.headers or {}), "Cache-Control": "private, no-store"}
        options = getattr(exc, "calendar_options", None)
        if (
            isinstance(exc, GoogleConnectionError)
            and options is not None
            and isinstance(error.detail, dict)
        ):
            error.detail = {**error.detail, "calendar_options": options}
        raise error from exc


@router.post("/invitations")
async def invitations(
    payload: CalendarInvitationsWindow,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _selected_schedule(payload.account_id).invitations(
            user_id=firebase_uid, **payload.model_dump(exclude={"account_id"}, exclude_none=True)
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/review")
async def attendance_review(
    payload: CalendarAttendanceReview,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        return await _selected_schedule(payload.account_id).review(
            user_id=token["user_id"], **payload.model_dump(exclude={"account_id"})
        )
    except (GmailDeliveryError, GmailApiError) as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "reason_code": exc.code, "message": str(exc)},
        ) from exc
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/confirm")
async def attendance_confirm(
    payload: CalendarAttendanceConfirm,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    try:
        return await _selected_schedule(payload.account_id).confirm(
            user_id=token["user_id"], **payload.model_dump(exclude={"account_id"})
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/rescheduling/options")
@limiter.limit("10/minute")
async def public_rescheduling_options(request: Request, payload: CalendarPublicOptions):
    # The encrypted, expiring capability grants only the reviewed free slots.
    # No owner token, event reads or booking/mutation authority is exposed.
    from fastapi.responses import JSONResponse

    from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService

    try:
        plan = CalendarScheduleService._open(payload.token, "calendar-public-v1")
        return JSONResponse(
            await _selected_schedule(plan.get("account_id", "default")).public_options(
                token=payload.token
            ),
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )
    except Exception as exc:
        raise _http(exc) from exc


class CalendarMeetingSelection(BaseModel):
    expected_account_email: str = Field(min_length=1, max_length=512)
    calendar_id: str = Field(min_length=1, max_length=1024)
    event_id: str = Field(min_length=1, max_length=2048)


def _insights():
    from hushh_mcp.services.calendar_insights_service import CalendarInsightsService

    return CalendarInsightsService()


def _artifacts():
    from hushh_mcp.services.calendar_meeting_artifacts import CalendarMeetingArtifacts

    return CalendarMeetingArtifacts()


@router.post("/insights")
async def insights(
    payload: CalendarDay,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await _insights().overview(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


class CalendarMeetingPage(CalendarDay):
    page: int = Field(default=0, ge=0, le=1000)


@router.post("/meetings")
async def meeting_library(
    payload: CalendarMeetingPage,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await _insights().library(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/meetings/detail")
async def meeting_detail(
    payload: CalendarMeetingSelection,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await _artifacts().detail(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/meetings/context")
async def meeting_context(
    payload: CalendarMeetingSelection,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    response.headers["Cache-Control"] = "private, no-store"
    try:
        detail = await _artifacts().detail(user_id=firebase_uid, **payload.model_dump())
        sources = [
            {
                "title": item["title"],
                "url": item["url"],
                "text": item["text"],
                "truncated": item.get("truncated", False),
            }
            for item in detail["artifacts"]
            if item.get("can_ask") and item.get("text")
        ]
        if not sources:
            raise HTTPException(
                status_code=403,
                detail={"message": "No meeting text is currently authorized for One."},
            )
        return {"title": detail["event"]["title"], "sources": sources}
    except HTTPException:
        raise
    except Exception as exc:
        raise _http(exc) from exc
