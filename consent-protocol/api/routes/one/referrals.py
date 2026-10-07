"""Referral program routes for the One product shell.

One authenticated surface for now: the summary the Profile Referrals tab
renders. It is deliberately the only place a slug gets minted, so a person's
link exists the first time they look for it and never before.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.middleware import require_firebase_auth
from api.referral_listener import get_referral_queue, release_referral_queue
from hushh_mcp.operons.referral_scoring.weekly_cutoff import next_weekly_cutoff
from hushh_mcp.services.one_referral_circle_service import (
    CircleSelectionError,
    get_active_circle_selection,
    select_competition_circle,
)
from hushh_mcp.services.one_referral_display_handle_service import (
    DisplayHandleError,
    DisplayHandleTaken,
    get_display_handle,
    set_display_handle,
)
from hushh_mcp.services.one_referral_leaderboard_service import (
    get_circle_leaderboard,
    get_engagement_status,
    get_individual_leaderboard,
    get_milestone_progress,
)
from hushh_mcp.services.one_referral_program_settings_service import (
    ProgramSettingsUnavailable,
    get_active_program_settings,
)
from hushh_mcp.services.one_referral_scoring_service import get_cumulative_score
from hushh_mcp.services.one_referral_service import (
    ReferralProgramDisabled,
    ReferralServiceError,
    bind_attribution,
    get_referral_summary,
    resolve_slug_for_attribution,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/referrals", tags=["One Referrals"])


@router.get("/summary")
async def referral_summary(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's referral link and how their referrals are doing.

    A failure here must never look like a broken Profile: the tab renders its
    own retry state, so the error stays a status code and a short message with
    nothing internal in it.
    """
    try:
        return get_referral_summary(firebase_uid)
    except ReferralProgramDisabled:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_OFF"})
    except ReferralServiceError:
        logger.exception("[referrals] summary_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_SUMMARY_FAILED"})
    except Exception:
        logger.exception("[referrals] summary_unexpected")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_SUMMARY_FAILED"})


class ResolveSlugRequest(BaseModel):
    slug: str = Field(..., max_length=128)
    source: str | None = Field(default=None, max_length=64)
    campaign: str | None = Field(default=None, max_length=64)
    landing_route: str | None = Field(default=None, max_length=256)


class BindAttributionRequest(BaseModel):
    attribution_id: str = Field(..., max_length=64)


@router.post("/resolve")
async def resolve_referral_slug(payload: ResolveSlugRequest, request: Request):
    """Open a referral link. Public by necessity -- there is no session yet.

    Answers identically for an invalid slug, a disabled one, and one whose owner
    is gone. A caller must not be able to learn which slugs exist by trying
    them, so there is exactly one negative answer.
    """
    try:
        return resolve_slug_for_attribution(
            payload.slug,
            user_agent=request.headers.get("user-agent"),
            source=payload.source,
            campaign=payload.campaign,
            landing_route=payload.landing_route,
        )
    except Exception:
        logger.exception("[referrals] resolve_failed")
        # Even a server fault answers with the neutral shape: the person can
        # still sign in, they simply arrive unattributed.
        return {"status": "unavailable"}


@router.post("/bind")
async def bind_referral_attribution(
    payload: BindAttributionRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Attach a pending attribution to the person who just signed in."""
    try:
        return bind_attribution(payload.attribution_id, firebase_uid)
    except ReferralProgramDisabled:
        return {"status": "unavailable"}
    except Exception:
        logger.exception("[referrals] bind_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_BIND_FAILED"})


class SelectCircleRequest(BaseModel):
    circle_id: str = Field(..., max_length=64)


@router.get("/circle")
async def referral_circle_selection(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's current referral-contest team, if any."""
    selection = get_active_circle_selection(firebase_uid)
    if selection is None:
        return {"circle_id": None}
    return {"circle_id": selection.circle_id, "selected_at": selection.selected_at.isoformat()}


@router.post("/circle")
async def select_referral_circle(
    payload: SelectCircleRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Choose this person's one active referral-contest team.

    Requires the caller already be an accepted member of that Location
    Circle -- this endpoint grants no membership and changes no capacity.
    """
    try:
        selection = select_competition_circle(firebase_uid, payload.circle_id)
    except CircleSelectionError:
        raise HTTPException(status_code=403, detail={"code": "REFERRAL_CIRCLE_NOT_A_MEMBER"})
    except Exception:
        logger.exception("[referrals] circle_selection_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_CIRCLE_SELECTION_FAILED"})
    return {"circle_id": selection.circle_id, "selected_at": selection.selected_at.isoformat()}


class SetHandleRequest(BaseModel):
    handle: str = Field(..., max_length=32)


@router.get("/handle")
async def referral_display_handle(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's own chosen public leaderboard handle, if any set."""
    return {"handle": get_display_handle(firebase_uid)}


@router.post("/handle")
async def set_referral_display_handle(
    payload: SetHandleRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Choose or change this person's own public leaderboard handle.

    Never derived from or compared against the account's real/account name --
    accepting or rejecting a handle has nothing to do with what Firebase or
    `actor_identity_cache` knows about this person.
    """
    try:
        handle = set_display_handle(firebase_uid, payload.handle)
    except DisplayHandleTaken:
        raise HTTPException(status_code=409, detail={"code": "REFERRAL_HANDLE_TAKEN"})
    except DisplayHandleError:
        raise HTTPException(status_code=422, detail={"code": "REFERRAL_HANDLE_INVALID"})
    except Exception:
        logger.exception("[referrals] set_handle_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_HANDLE_FAILED"})
    return {"handle": handle}


@router.get("/points")
async def referral_cumulative_points(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's own recorded point total, summed live from the ledger.

    Deliberately independent of the published leaderboard snapshot: a
    referrer whose points just posted, or who has never appeared in a
    snapshot at all (not yet ranked, or no snapshot has published since they
    joined), still sees their real balance here. `user_id` comes only from
    the verified token, never a request parameter -- this can only ever
    answer for the caller's own account.
    """
    return {"points": get_cumulative_score(firebase_uid)}


@router.get("/leaderboard")
async def referral_individual_leaderboard(
    after_rank: int = 0,
    limit: int = 20,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """One page of the latest published cumulative-ranking snapshot.

    Points, not raw referral counts, and always from a published snapshot --
    never a live aggregate the caller could use to probe exact real-time
    standing. The caller's own row is included even when it falls outside
    this page.
    """
    bounded_limit = max(1, min(limit, 50))
    return get_individual_leaderboard(
        limit=bounded_limit, after_rank=max(0, after_rank), viewer_user_id=firebase_uid
    )


@router.get("/circles/leaderboard")
async def referral_circle_leaderboard(
    limit: int = 20,
    _firebase_uid: str = Depends(require_firebase_auth),
):
    """Cumulative RAW qualified-referral count per contest team."""
    return {"teams": get_circle_leaderboard(limit=max(1, min(limit, 50)))}


@router.get("/challenge")
async def referral_weekly_challenge(_firebase_uid: str = Depends(require_firebase_auth)):
    """The current seven-day challenge round's start and close.

    A display computation only, derived from the active settings version's
    `weekly_schedule` -- it never creates or reads a reward-round row. Returns
    `active: false` with no window when the schedule is unset (v1's state) or
    the active row cannot be found, so the dashboard can render a "not yet
    scheduled" state instead of guessing at a deadline.
    """
    try:
        settings = get_active_program_settings()
    except ProgramSettingsUnavailable:
        return {"active": False, "week_started_at": None, "cutoff_at": None, "timezone": None}
    window = next_weekly_cutoff(datetime.now(timezone.utc), settings.weekly_schedule)
    if window is None:
        return {"active": False, "week_started_at": None, "cutoff_at": None, "timezone": None}
    return {
        "active": True,
        "week_started_at": window.week_started_at.isoformat(),
        "cutoff_at": window.cutoff_at.isoformat(),
        "timezone": window.timezone,
    }


@router.get("/milestones")
async def referral_milestone_progress(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's lifetime milestone progress and earned merchandise."""
    try:
        settings = get_active_program_settings()
    except ProgramSettingsUnavailable:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_SETTINGS_OFF"})
    return get_milestone_progress(firebase_uid, settings_milestones=settings.milestones)


@router.get("/engagement")
async def referral_engagement_status(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's streak progress and whether a flash window is active now.

    Display-only -- an award itself is always decided by the scoring worker,
    never by this read.
    """
    try:
        settings = get_active_program_settings()
    except ProgramSettingsUnavailable:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_SETTINGS_OFF"})
    program_timezone = str(settings.weekly_schedule.get("timezone") or "").strip() or "UTC"
    return get_engagement_status(
        firebase_uid, flash_windows=settings.flash_windows, program_timezone=program_timezone
    )


# Long enough that a quiet stream is not mistaken for a dead one by any proxy in
# front of us, short enough that a phone on a train notices the drop quickly.
_HEARTBEAT_SECONDS = 25


async def _referral_event_stream(user_id: str, request: Request):
    """One referrer's live stream.

    Yields a doorbell -- never data. The client re-reads the summary through the
    authenticated endpoint that already owns what this referrer may see, so this
    stream can never become a second, quieter place where that decision is made.
    """
    queue = get_referral_queue(user_id)
    # Tells the client the stream is live, so it can stop polling immediately
    # rather than after one more interval.
    yield {"event": "ready", "data": json.dumps({"channel": "referrals"})}

    try:
        while True:
            if await request.is_disconnected():
                break
            try:
                message = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                yield {
                    "event": "heartbeat",
                    "data": json.dumps({"timestamp": int(time.time() * 1000)}),
                }
                continue

            yield {
                "event": "referral_changed",
                "data": json.dumps({"reason": message.get("reason", "changed")}),
            }
    except asyncio.CancelledError:
        raise
    finally:
        await release_referral_queue(user_id)


@router.get("/events")
async def referral_events(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Push referral changes to the person they belong to.

    Authenticated like every other referral read, and scoped to the caller by
    the token rather than by anything in the URL: a stream keyed on a path
    parameter is a stream someone can point at another person.
    """
    return EventSourceResponse(
        _referral_event_stream(firebase_uid, request),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
