"""Owner preferences/meeting reads and pinned OIDC scheduler admission."""

from __future__ import annotations

import asyncio
import os
from typing import Any, cast
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from google.auth.exceptions import TransportError
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.calendar import _http
from hushh_mcp.services.calendar_reminder_service import CalendarReminderService, reminders_enabled
from hushh_mcp.services.calendar_reminder_store import CalendarReminderStore

router = APIRouter(prefix="/api/one/calendar", tags=["One Calendar reminders"])
NO_STORE = {"Cache-Control": "private, no-store"}


class ReminderPreferences(BaseModel):
    enabled: bool
    show_title: bool = True
    time_zone: str = Field(default="UTC", min_length=1, max_length=128)


class JoinMeeting(BaseModel):
    event_id: str = Field(min_length=1, max_length=2048)


@router.get("/reminders/preferences")
async def get_preferences(response: Response, owner: str = Depends(require_firebase_auth)):
    response.headers.update(NO_STORE)
    try:
        return {
            **await CalendarReminderStore().preferences(owner),
            "available": reminders_enabled(),
            "minutes_before": 10,
        }
    except Exception as exc:
        raise _http(exc) from exc


@router.put("/reminders/preferences")
async def set_preferences(
    payload: ReminderPreferences, response: Response, owner: str = Depends(require_firebase_auth)
):
    response.headers.update(NO_STORE)
    store = CalendarReminderStore()
    if payload.enabled and not reminders_enabled():
        try:
            existing = await store.preferences(owner)
        except Exception as exc:
            raise _http(exc) from exc
        if not existing["enabled"]:
            raise HTTPException(503, "Meeting reminders are not available yet", headers=NO_STORE)
    try:
        ZoneInfo(payload.time_zone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, "Choose a valid time zone", headers=NO_STORE) from None
    try:
        prefs = await store.set_preferences(owner, **payload.model_dump())
        return {**prefs, "available": reminders_enabled(), "minutes_before": 10}
    except ValueError:
        raise HTTPException(
            409, "Connect Calendar before enabling reminders", headers=NO_STORE
        ) from None
    except Exception as exc:
        raise _http(exc) from exc


@router.get("/reminders/{reminder_id}")
async def resolve_reminder(
    reminder_id: UUID, response: Response, token: dict = Depends(require_vault_owner_token)
):
    response.headers.update(NO_STORE)
    try:
        return await CalendarReminderService().resolve(token["user_id"], str(reminder_id))
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/meetings/join")
async def join_meeting(
    payload: JoinMeeting, response: Response, token: dict = Depends(require_vault_owner_token)
):
    response.headers.update(NO_STORE)
    try:
        return await CalendarReminderService().join(token["user_id"], payload.event_id)
    except Exception as exc:
        raise _http(exc) from exc


def _scheduler_configuration() -> tuple[str, str]:
    environment = os.getenv("ENVIRONMENT", "").lower()
    if environment == "production":
        return (
            "https://api.hushh.ai",
            "calendar-meeting-reminders@hushh-pda.iam.gserviceaccount.com",
        )
    if environment in {"uat", "test", "local", "development"}:
        return (
            "https://api.uat.hushh.ai",
            "calendar-meeting-reminders@hushh-pda-uat.iam.gserviceaccount.com",
        )
    raise HTTPException(503, "Calendar reminder scheduler unavailable", headers=NO_STORE)


def _verify_oidc(token: str, audience: str) -> dict[str, Any]:
    transport = GoogleRequest()

    def bounded(*args, **kwargs):
        return transport(*args, **{**kwargs, "timeout": 4})

    return cast(dict[str, Any], id_token.verify_oauth2_token(token, bounded, audience))


async def _require_scheduler(request: Request) -> None:
    if not reminders_enabled():
        raise HTTPException(404, "Calendar reminder scheduler unavailable", headers=NO_STORE)
    audience, account = _scheduler_configuration()
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer ") or not 1 <= len(authorization[7:]) <= 8192:
        raise HTTPException(401, "Calendar reminder scheduler unauthorized", headers=NO_STORE)
    try:
        claims = await asyncio.wait_for(
            run_in_threadpool(_verify_oidc, authorization[7:], audience), timeout=5
        )
    except (TimeoutError, TransportError):
        raise HTTPException(
            503, "Calendar reminder scheduler unavailable", headers=NO_STORE
        ) from None
    except Exception:
        raise HTTPException(
            401, "Calendar reminder scheduler unauthorized", headers=NO_STORE
        ) from None
    if (
        claims.get("email") != account
        or claims.get("email_verified") is not True
        or claims.get("aud") != audience
        or claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}
    ):
        raise HTTPException(401, "Calendar reminder scheduler unauthorized", headers=NO_STORE)


@router.post("/reminders/drain")
async def drain(response: Response, _: None = Depends(_require_scheduler)):
    response.headers.update(NO_STORE)
    try:
        return await asyncio.wait_for(CalendarReminderService().drain(), timeout=55)
    except Exception:
        raise HTTPException(
            503, "Calendar reminder scheduler unavailable", headers=NO_STORE
        ) from None
