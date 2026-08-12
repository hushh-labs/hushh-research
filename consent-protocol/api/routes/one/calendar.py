"""Google Calendar connection, read, and confirmation-bound action routes."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token, verify_user_id_match
from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/calendar", tags=["One Calendar"])


class _UserRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)


class CalendarConnectStart(_UserRequest):
    access_level: Literal["read", "manage"] = "read"
    redirect_uri: str | None = Field(default=None, max_length=2048)
    login_hint: str | None = Field(default=None, max_length=512)


class CalendarConnectComplete(_UserRequest):
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)
    redirect_uri: str | None = Field(default=None, max_length=2048)


class CalendarDisconnect(_UserRequest):
    pass


class CalendarRange(BaseModel):
    start_at: str = Field(min_length=1, max_length=64)
    end_at: str = Field(min_length=1, max_length=64)
    calendar_ids: list[str] | None = Field(default=None, max_length=20)


class CalendarProposal(_UserRequest):
    action: Literal["create", "reschedule", "cancel"]
    event_id: str | None = Field(default=None, max_length=2048)
    title: str | None = Field(default=None, max_length=512)
    start_at: str | None = Field(default=None, max_length=64)
    end_at: str | None = Field(default=None, max_length=64)
    time_zone: str | None = Field(default=None, max_length=128)
    attendees: list[str] = Field(default_factory=list, max_length=100)
    description: str | None = Field(default=None, max_length=8000)
    location: str | None = Field(default=None, max_length=1024)
    send_updates: bool = True


class CalendarExecute(_UserRequest):
    proposal_id: str = Field(min_length=8, max_length=256)


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, GoogleConnectionError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": "GOOGLE_CALENDAR_ERROR", "message": str(exc)},
        )
    logger.exception("one.calendar.unexpected_error")
    return HTTPException(
        status_code=503,
        detail={
            "code": "GOOGLE_CALENDAR_UNAVAILABLE",
            "message": "Google Calendar is temporarily unavailable.",
        },
    )


@router.post("/connect/start")
async def start_connect(
    payload: CalendarConnectStart, firebase_uid: str = Depends(require_firebase_auth)
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await get_google_connection_service().start(
            user_id=payload.user_id,
            service="calendar",
            access_level=payload.access_level,
            redirect_uri=payload.redirect_uri,
            login_hint=payload.login_hint,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/connect/complete")
async def complete_connect(
    payload: CalendarConnectComplete, firebase_uid: str = Depends(require_firebase_auth)
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await get_google_connection_service().complete(
            user_id=payload.user_id,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.get("/status/{user_id}")
async def calendar_status(user_id: str, firebase_uid: str = Depends(require_firebase_auth)):
    verify_user_id_match(firebase_uid, user_id)
    try:
        return get_google_connection_service().status(user_id=user_id, service="calendar")
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/disconnect")
async def disconnect(
    payload: CalendarDisconnect, firebase_uid: str = Depends(require_firebase_auth)
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return get_google_connection_service().disconnect_service(
            user_id=payload.user_id, service="calendar"
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/events")
async def events(payload: CalendarRange, token: dict = Depends(require_vault_owner_token)):
    try:
        return await get_google_calendar_service().list_events(
            user_id=token["user_id"], start_at=payload.start_at, end_at=payload.end_at
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/availability")
async def availability(payload: CalendarRange, token: dict = Depends(require_vault_owner_token)):
    try:
        return await get_google_calendar_service().freebusy(
            user_id=token["user_id"],
            start_at=payload.start_at,
            end_at=payload.end_at,
            calendar_ids=payload.calendar_ids,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/proposals")
async def proposal(payload: CalendarProposal, token: dict = Depends(require_vault_owner_token)):
    verify_user_id_match(token["user_id"], payload.user_id)
    try:
        return await get_google_calendar_service().propose(
            user_id=token["user_id"],
            action=payload.action,
            payload=payload.model_dump(exclude={"user_id", "action"}),
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/proposals/execute")
async def execute(payload: CalendarExecute, token: dict = Depends(require_vault_owner_token)):
    verify_user_id_match(token["user_id"], payload.user_id)
    try:
        return await get_google_calendar_service().execute(
            user_id=token["user_id"], proposal_id=payload.proposal_id
        )
    except Exception as exc:
        raise _http(exc) from exc
