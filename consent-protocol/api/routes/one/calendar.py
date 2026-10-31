"""Google Calendar connection, read, and confirmation-bound action routes."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, StrictBool

from api.middleware import require_firebase_auth, verify_user_id_match
from api.middlewares.rate_limit import limiter
from hushh_mcp.services.google_calendar_service import (
    calendar_reads_via_door,
    get_google_calendar_service,
)
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)
from hushh_mcp.services.owner_placement_guard import hub_content_firebase, hub_content_owner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/calendar", tags=["One Calendar"])


class _UserRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)


class CalendarConnectStart(_UserRequest):
    access_level: Literal["read", "manage"] = "read"
    redirect_uri: str | None = Field(default=None, max_length=2048)
    login_hint: str | None = Field(default=None, max_length=512)
    additional: bool = False
    account_id: str | None = Field(default=None, min_length=1, max_length=128)
    include_meeting_files: bool = False


class CalendarConnectComplete(_UserRequest):
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)
    redirect_uri: str | None = Field(default=None, max_length=2048)


class CalendarNativeConnectStart(BaseModel):
    include_calendar_list: bool = False
    include_meeting_files: bool = False
    additional: bool = False
    account_id: str | None = Field(default=None, min_length=1, max_length=128)
    access_level: Literal["read", "manage"] = "read"


class CalendarNativeConnectComplete(_UserRequest):
    access_level: Literal["read", "manage"] = "read"
    server_auth_code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)


class CalendarDisconnect(_UserRequest):
    account_id: str = Field(default="default", min_length=1, max_length=128)


class CalendarGuestPhotoToken(_UserRequest):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    grant_generation: str = Field(pattern=r"^[a-f0-9]{64}$")
    provider_subject_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


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
    account_id: str = Field(default="default", min_length=1, max_length=128)
    booking_source: Literal["board"] | None = None
    checked_account_ids: list[str] | None = Field(default=None, min_length=1, max_length=3)
    calendar_overrides_by_account: dict[str, dict[str, StrictBool]] | None = Field(
        default=None, max_length=3
    )
    selected_date: str | None = Field(default=None, min_length=10, max_length=10)
    meeting_type: Literal["google_meet", "external_link", "in_person"] | None = None
    meeting_link: str | None = Field(default=None, max_length=2048)


class CalendarExecute(_UserRequest):
    proposal_id: str = Field(min_length=8, max_length=256)
    account_id: str = Field(default="default", min_length=1, max_length=128)


def _selected_calendar(account_id: str):
    if account_id == "default":
        return get_google_calendar_service()
    if calendar_reads_via_door():
        raise GoogleConnectionError(
            "Additional Calendar account booking is unavailable in this runtime",
            status_code=403,
            reason_code="calendar_account_unavailable",
        )
    from hushh_mcp.services.calendar_account_board_service import account_schedule

    return account_schedule(account_id).calendar


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, GoogleConnectionError):
        return HTTPException(
            status_code=exc.status_code,
            detail={
                "code": "GOOGLE_CALENDAR_ERROR",
                "message": str(exc),
                **({"reason_code": exc.reason_code} if exc.reason_code else {}),
            },
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
    payload: CalendarConnectStart, firebase_uid: str = Depends(hub_content_firebase)
):
    verify_user_id_match(firebase_uid, payload.user_id)
    if payload.account_id is not None and not payload.additional:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CALENDAR_ACCOUNT_TARGET_INVALID",
                "message": "Select an additional Calendar account before reconnecting it.",
            },
        )
    try:
        return await get_google_connection_service().start(
            user_id=payload.user_id,
            service="calendar",
            access_level=payload.access_level,
            redirect_uri=payload.redirect_uri,
            login_hint=payload.login_hint,
            **({"calendar_additional": True} if payload.additional else {}),
            **({"calendar_account_id": payload.account_id} if payload.account_id else {}),
            **({"include_meeting_files": True} if payload.include_meeting_files else {}),
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/connect/complete")
async def complete_connect(
    payload: CalendarConnectComplete, firebase_uid: str = Depends(hub_content_firebase)
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await get_google_connection_service().complete(
            user_id=payload.user_id,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
            # Reject and consume a retired Drive attempt before any provider
            # exchange. Calendar starts are the only attempts this route owns.
            expected_service="calendar",
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/connect/native/start")
async def start_native_connect(
    payload: CalendarNativeConnectStart | None = None,
    firebase_uid: str = Depends(hub_content_firebase),
):
    try:
        return await get_google_connection_service().start_native(
            user_id=firebase_uid,
            service="calendar",
            access_level=payload.access_level if payload else "read",
            **(
                {"include_calendar_list": True} if payload and payload.include_calendar_list else {}
            ),
            **(
                {"include_meeting_files": True} if payload and payload.include_meeting_files else {}
            ),
            **({"calendar_additional": True} if payload and payload.additional else {}),
            **(
                {"calendar_account_id": payload.account_id}
                if payload and payload.account_id
                else {}
            ),
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/connect/native/complete")
async def complete_native_connect(
    payload: CalendarNativeConnectComplete,
    firebase_uid: str = Depends(hub_content_firebase),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await get_google_connection_service().complete_native(
            user_id=payload.user_id,
            service="calendar",
            access_level=payload.access_level,
            server_auth_code=payload.server_auth_code,
            state=payload.state,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.get("/status/{user_id}")
async def calendar_status(user_id: str, firebase_uid: str = Depends(require_firebase_auth)):
    verify_user_id_match(firebase_uid, user_id)
    try:
        return await get_google_connection_service().calendar_accounts_status(user_id=user_id)
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/guest-photo-token")
@limiter.limit("12/minute")
async def guest_photo_token(
    request: Request,
    response: Response,
    payload: CalendarGuestPhotoToken,
    firebase_uid: str = Depends(hub_content_firebase),
    vault_owner: dict = Depends(hub_content_owner),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    verify_user_id_match(str(vault_owner["user_id"]), firebase_uid)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    try:
        return await get_google_connection_service().calendar_guest_photo_token(
            user_id=firebase_uid,
            account_id=payload.account_id,
            expected_generation=payload.grant_generation,
            expected_subject_sha256=payload.provider_subject_sha256,
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/disconnect")
async def disconnect(
    payload: CalendarDisconnect, firebase_uid: str = Depends(require_firebase_auth)
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await get_google_connection_service().disconnect_service(
            user_id=payload.user_id,
            service="calendar",
            **({"account_id": payload.account_id} if payload.account_id != "default" else {}),
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/events")
async def events(payload: CalendarRange, token: dict = Depends(hub_content_owner)):
    try:
        return await get_google_calendar_service().list_events(
            user_id=token["user_id"], start_at=payload.start_at, end_at=payload.end_at
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/availability")
async def availability(payload: CalendarRange, token: dict = Depends(hub_content_owner)):
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
async def proposal(payload: CalendarProposal, token: dict = Depends(hub_content_owner)):
    verify_user_id_match(token["user_id"], payload.user_id)
    try:
        return await _selected_calendar(payload.account_id).propose(
            user_id=token["user_id"],
            action=payload.action,
            payload=payload.model_dump(exclude={"user_id", "action"}),
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/proposals/execute")
async def execute(payload: CalendarExecute, token: dict = Depends(hub_content_owner)):
    verify_user_id_match(token["user_id"], payload.user_id)
    try:
        return await _selected_calendar(payload.account_id).execute(
            user_id=token["user_id"],
            proposal_id=payload.proposal_id,
            account_id=payload.account_id,
        )
    except Exception as exc:
        raise _http(exc) from exc
