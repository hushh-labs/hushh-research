"""Connected Calendar workspace APIs, separate from lifecycle/chat/setup contracts."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.middleware import (
    require_firebase_auth,
    require_firebase_auth_read_only,
    require_vault_owner_token,
    verify_user_id_match,
)
from api.middlewares.rate_limit import limiter
from api.routes.one.calendar import _http

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


class CalendarAttendanceReview(CalendarOpeningWindow):
    event_id: str = Field(min_length=1, max_length=2048)
    calendar_id: Literal["primary"] = "primary"
    offer_times: bool = False
    message: str = Field(default="", max_length=8000)


class CalendarAttendanceConfirm(BaseModel):
    review_id: str = Field(min_length=16, max_length=128)
    review_token: str = Field(min_length=40, max_length=40000)


class CalendarPublicOptions(BaseModel):
    token: str = Field(min_length=40, max_length=40000)


def _schedule():
    from hushh_mcp.services.calendar_schedule_service import get_calendar_schedule_service

    return get_calendar_schedule_service()


@router.post("/schedule/today")
async def schedule_today(payload: CalendarDay, response: Response, firebase_uid: str = Depends(require_firebase_auth_read_only)):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _schedule().today(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/schedule/availability")
async def schedule_availability(
    payload: CalendarOpeningWindow, response: Response, firebase_uid: str = Depends(require_firebase_auth_read_only)
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _schedule().free_windows(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/review")
async def attendance_review(
    payload: CalendarAttendanceReview,
    token: dict = Depends(require_vault_owner_token),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        return await _schedule().review(user_id=token["user_id"], **payload.model_dump())
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
    token: dict = Depends(require_vault_owner_token),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    try:
        return await _schedule().confirm(user_id=token["user_id"], **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/rescheduling/options")
@limiter.limit("10/minute")
async def public_rescheduling_options(request: Request, payload: CalendarPublicOptions):
    # The encrypted, expiring capability grants only the reviewed free slots.
    # No owner token, event reads or booking/mutation authority is exposed.
    from fastapi.responses import JSONResponse

    try:
        return JSONResponse(
            await _schedule().public_options(token=payload.token),
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )
    except Exception as exc:
        raise _http(exc) from exc
