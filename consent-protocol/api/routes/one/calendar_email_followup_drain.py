"""OIDC-only scheduled follow-up scan and reminder drain."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from api.routes.one.scheduled_mail_drain import _verify_scheduled_mail_drain_oidc_token
from hushh_mcp.services.calendar_email_followup_reminders import drain_due_reminders
from hushh_mcp.services.calendar_email_followup_scan import scan_once
from hushh_mcp.services.calendar_email_followup_store import CalendarEmailFollowupStore
from hushh_mcp.services.owner_placement_guard import hub_content_inline

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/calendar/followups", tags=["One Calendar Follow-ups"])
_NO_STORE = {"Cache-Control": "private, no-store"}
_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}


def _config() -> tuple[str, str]:
    environment = str(os.getenv("ENVIRONMENT") or "").lower()
    if environment == "production":
        return "https://api.hushh.ai", "calendar-email-followups@hushh-pda.iam.gserviceaccount.com"
    if environment in {"uat", "test", "local", "development"}:
        return (
            "https://api.uat.hushh.ai",
            "calendar-email-followups@hushh-pda-uat.iam.gserviceaccount.com",
        )
    raise RuntimeError("follow-up drain environment is unavailable")


def _enabled() -> bool:
    return os.getenv("CALENDAR_EMAIL_FOLLOWUPS", "").lower() in {"1", "true", "yes"} and os.getenv(
        "CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED", ""
    ).lower() in {"1", "true", "yes"}


async def _require_scheduler(request: Request) -> None:
    if not _enabled():
        raise HTTPException(404, detail={"code": "FOLLOWUP_DRAIN_DISABLED"}, headers=_NO_STORE)
    try:
        audience, service_account = _config()
    except RuntimeError:
        raise HTTPException(
            503, detail={"code": "FOLLOWUP_DRAIN_UNAVAILABLE"}, headers=_NO_STORE
        ) from None
    authorization = str(request.headers.get("authorization") or "")
    token = authorization.removeprefix("Bearer ").strip()
    if not authorization.startswith("Bearer ") or not token or len(token) > 8192:
        raise HTTPException(401, detail={"code": "FOLLOWUP_DRAIN_UNAUTHORIZED"}, headers=_NO_STORE)
    try:
        claims: dict[str, Any] = await asyncio.wait_for(
            run_in_threadpool(_verify_scheduled_mail_drain_oidc_token, token, audience),
            timeout=5,
        )
    except TimeoutError:
        raise HTTPException(
            503, detail={"code": "FOLLOWUP_DRAIN_UNAVAILABLE"}, headers=_NO_STORE
        ) from None
    except Exception:
        raise HTTPException(
            401, detail={"code": "FOLLOWUP_DRAIN_UNAUTHORIZED"}, headers=_NO_STORE
        ) from None
    if (
        claims.get("email") != service_account
        or claims.get("email_verified") is not True
        or claims.get("iss") not in _ISSUERS
        or claims.get("aud") != audience
    ):
        raise HTTPException(401, detail={"code": "FOLLOWUP_DRAIN_UNAUTHORIZED"}, headers=_NO_STORE)


@router.post("/drain")
@hub_content_inline("calendar_followup_each_owner")
async def drain_followups(
    response: Response,
    limit: int = Query(default=10, ge=1, le=20),
    _authorized: None = Depends(_require_scheduler),
) -> dict[str, Any]:
    response.headers.update(_NO_STORE)
    store = CalendarEmailFollowupStore()
    accounts = await store.due_accounts(limit=limit)
    scans = {"attempted": 0, "partial": 0}
    for user_id, account_id in accounts:
        try:
            result = await scan_once(user_id=user_id, account_id=account_id, store=store)
            scans["attempted"] += 1
            scans["partial"] += int(result["state"] == "partial")
        except Exception as exc:
            logger.warning("calendar_followups.scan_deferred error_type=%s", type(exc).__name__)
            scans["partial"] += 1
    reminders = await drain_due_reminders(store=store, limit=limit)
    return {"scans": scans, "reminders": reminders}
