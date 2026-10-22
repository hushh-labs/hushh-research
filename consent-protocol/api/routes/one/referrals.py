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
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sse_starlette.sse import EventSourceResponse

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.referral_listener import get_referral_queue, release_referral_queue
from hushh_mcp.operons.referral_scoring.weekly_cutoff import next_weekly_cutoff
from hushh_mcp.services import one_referral_circle_service as circle_wars
from hushh_mcp.services.one_referral_activity_service import (
    get_balances,
    get_transaction_history,
    reconcile_product_activity,
    record_app_open,
)
from hushh_mcp.services.one_referral_challenge_service import get_challenge_status
from hushh_mcp.services.one_referral_display_handle_service import (
    DisplayHandleError,
    DisplayHandleTaken,
    get_display_handle,
    set_display_handle,
)
from hushh_mcp.services.one_referral_leaderboard_service import (
    get_engagement_status,
    get_individual_leaderboard,
    get_milestone_progress,
)
from hushh_mcp.services.one_referral_program_settings_service import (
    ProgramSettingsUnavailable,
    get_active_program_settings,
)
from hushh_mcp.services.one_referral_rewards_service import RewardClaimError, claim_milestone
from hushh_mcp.services.one_referral_service import (
    ReferralProgramDisabled,
    ReferralServiceError,
    bind_attribution,
    get_referral_summary,
    resolve_slug_for_attribution,
    rotate_referral_code,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/referrals", tags=["One Referrals"])


class CircleWarsOptInRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    circle_id: UUID
    consent: StrictBool


def _circle_wars_result(response: Response, operation, *args, **kwargs):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return operation(*args, **kwargs)
    except circle_wars.CircleWarsError as exc:
        raise HTTPException(status_code=exc.status, detail={"code": exc.code}) from exc
    except ReferralProgramDisabled as exc:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_OFF"}) from exc
    except Exception as exc:
        logger.exception("[circle_wars] operation_failed")
        raise HTTPException(status_code=503, detail={"code": "CIRCLE_WARS_UNAVAILABLE"}) from exc


@router.get("/circle-wars")
def circle_wars_state(
    response: Response,
    week: UUID | None = None,
    token_data: dict = Depends(require_vault_owner_token),
):
    return _circle_wars_result(response, circle_wars.get_state, token_data["user_id"], week)


@router.post("/circle-wars/participation")
def circle_wars_opt_in(
    payload: CircleWarsOptInRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    if not payload.consent:
        raise HTTPException(status_code=422, detail={"code": "EXPLICIT_OPT_IN_REQUIRED"})
    return _circle_wars_result(
        response, circle_wars.opt_in, token_data["user_id"], str(payload.circle_id)
    )


@router.get("/circle-wars/leaderboard")
def circle_wars_leaderboard(
    response: Response,
    week: UUID | None = None,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=2147483647),
    token_data: dict = Depends(require_vault_owner_token),
):
    return _circle_wars_result(
        response,
        circle_wars.get_leaderboard,
        token_data["user_id"],
        week=week,
        limit=limit,
        offset=offset,
    )


@router.get("/circle-wars/circles/{circle_id}")
def circle_wars_circle_stats(
    circle_id: UUID,
    response: Response,
    week: UUID | None = None,
    token_data: dict = Depends(require_vault_owner_token),
):
    return _circle_wars_result(
        response, circle_wars.get_circle_stats, token_data["user_id"], str(circle_id), week
    )


@router.get("/summary")
def referral_summary(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=50),
    firebase_uid: str = Depends(require_firebase_auth),
):
    """This person's referral link and how their referrals are doing.

    A failure here must never look like a broken Profile: the tab renders its
    own retry state, so the error stays a status code and a short message with
    nothing internal in it.
    """
    try:
        return get_referral_summary(firebase_uid, offset=offset, limit=limit)
    except ReferralProgramDisabled:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_OFF"})
    except ReferralServiceError:
        logger.exception("[referrals] summary_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_SUMMARY_FAILED"})
    except Exception:
        logger.exception("[referrals] summary_unexpected")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_SUMMARY_FAILED"})


class RotateReferralRequest(BaseModel):
    slug: str = Field(..., min_length=1, max_length=128)


@router.post("/rotate")
def rotate_referral_link(
    payload: RotateReferralRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Revoke this owner's current invitation link without removing referral credits."""
    try:
        rotate_referral_code(firebase_uid, expected_slug=payload.slug)
        return get_referral_summary(firebase_uid)
    except ReferralProgramDisabled:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_OFF"})
    except Exception:
        logger.exception("[referrals] rotate_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_ROTATE_FAILED"})


class ResolveSlugRequest(BaseModel):
    slug: str = Field(..., max_length=128)
    source: str | None = Field(default=None, max_length=64)
    campaign: str | None = Field(default=None, max_length=64)
    landing_route: str | None = Field(default=None, max_length=256)


class BindAttributionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attribution_id: UUID


@router.post("/resolve")
def resolve_referral_slug(payload: ResolveSlugRequest, request: Request):
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
def bind_referral_attribution(
    payload: BindAttributionRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Attach a pending attribution to the person who just signed in."""
    try:
        return bind_attribution(str(payload.attribution_id), firebase_uid)
    except ReferralProgramDisabled:
        return {"status": "unavailable"}
    except Exception:
        logger.exception("[referrals] bind_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_BIND_FAILED"})


class SelectCircleRequest(BaseModel):
    circle_id: str = Field(..., max_length=64)


@router.get("/circle")
def referral_circle_selection(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's current referral-contest team, if any."""
    # Genealogy is automatic; it does not prove accepted referral-team membership.
    # Keep its historical records private until the opt-in team policy is approved.
    return {"circle_id": None, "status": "preview", "competition_active": False}


@router.post("/circle")
def select_referral_circle(
    payload: SelectCircleRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """The preview cannot create or infer accepted referral-team membership."""
    raise HTTPException(status_code=409, detail={"code": "REFERRAL_CIRCLE_PREVIEW"})


class SetHandleRequest(BaseModel):
    handle: str = Field(..., max_length=32)


@router.get("/handle")
def referral_display_handle(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's own chosen public leaderboard handle, if any set."""
    return {"handle": get_display_handle(firebase_uid)}


@router.post("/handle")
def set_referral_display_handle(
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
def referral_cumulative_points(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's own recorded point total, summed live from the ledger.

    Deliberately independent of the published leaderboard snapshot: a
    referrer whose points just posted, or who has never appeared in a
    snapshot at all (not yet ranked, or no snapshot has published since they
    joined), still sees their real balance here. `user_id` comes only from
    the verified token, never a request parameter -- this can only ever
    answer for the caller's own account.
    """
    return get_balances(firebase_uid)


@router.get("/leaderboard")
def referral_individual_leaderboard(
    after_rank: int = 0,
    limit: int = 20,
    snapshot_id: UUID | None = None,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Cumulative Coins from the shared on-demand snapshot and off-page viewer.

    Handles are approved public aliases; account identifiers remain private.
    """
    bounded_limit = max(1, min(limit, 50))
    return get_individual_leaderboard(
        limit=bounded_limit,
        after_rank=max(0, after_rank),
        viewer_user_id=firebase_uid,
        snapshot_id=str(snapshot_id) if snapshot_id else None,
    )


@router.get("/circles/leaderboard")
def referral_circle_leaderboard(
    limit: int = 20,
    after_rank: int = 0,
    _firebase_uid: str = Depends(require_firebase_auth),
):
    """No standings are published before accepted referral teams are available."""
    return {"teams": [], "next_after_rank": None, "status": "preview", "competition_active": False}


@router.get("/policy")
def referral_program_policy(_firebase_uid: str = Depends(require_firebase_auth)):
    """Public rule amounts from the active version, behind owner authentication."""
    try:
        settings = get_active_program_settings()
    except ProgramSettingsUnavailable:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_SETTINGS_OFF"})
    return {
        "version": settings.version,
        "challenge_duration_days": 7
        if next_weekly_cutoff(datetime.now(timezone.utc), settings.weekly_schedule)
        else None,
        "points": settings.points,
        "streak_rules": settings.streak_rules,
        "weekly_schedule": settings.weekly_schedule,
        "weekly_prizes_enabled": settings.feature_active,
        "flash_bonus_enabled": bool(settings.flash_windows),
    }


@router.get("/challenge")
def referral_weekly_challenge(_firebase_uid: str = Depends(require_firebase_auth)):
    """The persisted weekly window, status and server clock.

    An unset schedule renders an explicit not-configured state. Scheduling a
    window does not activate physical prizes; that remains a separate flag.
    """
    return get_challenge_status()


class ProductActivityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: UUID


@router.post("/activity")
def referral_product_activity(
    payload: ProductActivityRequest, firebase_uid: str = Depends(require_firebase_auth)
):
    return reconcile_product_activity(firebase_uid, str(payload.message_id))


class DashboardVisitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface: Literal["referral_dashboard"] | None = None


@router.post("/app-open")
def referral_app_open(
    payload: DashboardVisitRequest | None = None,
    firebase_uid: str = Depends(require_firebase_auth),
):
    return record_app_open(firebase_uid, dashboard_visit=bool(payload and payload.surface))


@router.get("/transactions")
def referral_transactions(
    before_id: int | None = Query(None, ge=1),
    limit: int = Query(20, ge=1, le=50),
    firebase_uid: str = Depends(require_firebase_auth),
):
    return get_transaction_history(firebase_uid, before_id, limit)


class ClaimRewardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    milestone_key: str = Field(min_length=1, max_length=128)


@router.post("/rewards/claim")
def referral_reward_claim(
    payload: ClaimRewardRequest, firebase_uid: str = Depends(require_firebase_auth)
):
    try:
        return claim_milestone(firebase_uid, payload.milestone_key)
    except RewardClaimError:
        raise HTTPException(
            status_code=409, detail={"code": "REWARD_NOT_EARNED_OR_ALREADY_CLAIMED"}
        )


@router.get("/milestones")
def referral_milestone_progress(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's lifetime milestone progress and earned merchandise."""
    try:
        settings = get_active_program_settings()
    except ProgramSettingsUnavailable:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_SETTINGS_OFF"})
    return {
        **get_milestone_progress(firebase_uid, settings_milestones=settings.milestones),
        "available_milestones": settings.milestones,
    }


@router.get("/engagement")
def referral_engagement_status(firebase_uid: str = Depends(require_firebase_auth)):
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
        firebase_uid,
        flash_windows=settings.flash_windows,
        program_timezone=program_timezone,
        run_length_days=int(settings.streak_rules.get("run_length_days", 3)),
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
    try:
        yield {"event": "ready", "data": json.dumps({"channel": "referrals"})}
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
        await release_referral_queue(user_id, queue)


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
