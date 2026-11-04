"""Authenticated manual email choice; never inferred from marketing permission."""

import asyncio
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from api.middleware import require_firebase_auth_read_only
from hushh_mcp.services import attempt_email as service
from hushh_mcp.services import attempt_email_feedback as feedback
from hushh_mcp.services.marketing_preferences import PreferenceConflict, VerifiedEmailRequired

router = APIRouter()
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


class AttemptEmailChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    expectedRevision: int = Field(ge=0, le=9_007_199_254_740_991)
    disclosureVersion: Literal["one-attempt-email-v1"]


@router.get("/attempt-email/preferences")
async def preference(uid: str = Depends(require_firebase_auth_read_only)):
    try:
        result = await asyncio.wait_for(service.preference(uid), timeout=15)
    except PermissionError:
        raise HTTPException(403, "Account unavailable", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Attempt email preference unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


class DeliveryClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accountId: str = Field(min_length=1, max_length=128)
    id: UUID
    claimId: UUID


class DeliverySettlement(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: UUID
    claimId: UUID
    providerId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,256}$")
    notSubmitted: bool = False


async def _worker_body(request: Request, purpose: str, *, delivery: bool = True):
    from .plg import _signed_body

    try:
        lane, secret = service.worker_authority()
    except PermissionError:
        raise HTTPException(404, "Attempt email worker unavailable", headers=NO_STORE) from None
    if delivery and not service.allowed_accounts():
        raise HTTPException(404, "Attempt email worker unavailable", headers=NO_STORE)
    raw = await _signed_body(request, secret=secret, purpose=f"attempt-emails.{lane}.{purpose}")
    return raw, lane


@router.get("/attempt-email/unsubscribe", response_class=HTMLResponse, include_in_schema=False)
async def unsubscribe_page(token: str = ""):
    if len(token) > 200:
        raise HTTPException(400, "Invalid unsubscribe link", headers=NO_STORE)
    return HTMLResponse(
        '<!doctype html><meta name="viewport" content="width=device-width"><title>Activity emails</title>'
        "<h1>Stop activity emails</h1><p>This stops emails for the choice linked in this message. "
        'A later choice in your account is kept.</p><form method="post"><input type="hidden" name="List-Unsubscribe" '
        'value="One-Click"><button type="submit">Stop activity emails</button></form>',
        headers={
            **NO_STORE,
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        },
    )


@router.post("/attempt-email/unsubscribe", include_in_schema=False)
async def unsubscribe(request: Request, token: str = ""):
    # GET scanners cannot revoke. Both the manual confirmation and RFC8058
    # one-click POST use the generation-bound bearer link, not an email address.
    if len(token) > 200:
        raise HTTPException(400, "Invalid unsubscribe link", headers=NO_STORE)
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 256:
            raise HTTPException(413, "Request too large", headers=NO_STORE)
    try:
        await asyncio.wait_for(service.unsubscribe(token), timeout=15)
    except ValueError:
        raise HTTPException(400, "Invalid unsubscribe link", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Unsubscribe not confirmed", headers=NO_STORE) from None
    return HTMLResponse(
        "<!doctype html><title>Activity emails</title><p>Activity emails for this choice are off. You can manage your current choice in your private agent account.</p>",
        headers={**NO_STORE, "Referrer-Policy": "no-referrer"},
    )


@router.post("/attempt-email/pull", include_in_schema=False)
async def pull(request: Request):
    raw, lane = await _worker_body(request, "pull")
    if raw != b"{}":
        raise HTTPException(400, "Invalid worker request", headers=NO_STORE)
    try:
        rows = await asyncio.wait_for(service.pending(), timeout=15)
    except Exception:
        raise HTTPException(503, "Attempt email queue unavailable", headers=NO_STORE) from None
    return JSONResponse({"environment": lane, "deliveries": rows}, headers=NO_STORE)


@router.post("/attempt-email/claim", include_in_schema=False)
async def claim(request: Request):
    raw, lane = await _worker_body(request, "claim")
    try:
        body = DeliveryClaim.model_validate_json(raw)
        result = await asyncio.wait_for(
            service.claim(body.accountId, body.id, body.claimId), timeout=25
        )
    except ValidationError:
        raise HTTPException(400, "Invalid worker request", headers=NO_STORE) from None
    except (VerifiedEmailRequired, PermissionError):
        result = None
    except Exception:
        raise HTTPException(503, "Attempt email claim not confirmed", headers=NO_STORE) from None
    return JSONResponse({"environment": lane, "delivery": result}, headers=NO_STORE)


@router.post("/attempt-email/settle", include_in_schema=False)
async def settle(request: Request):
    raw, lane = await _worker_body(request, "settle", delivery=False)
    try:
        body = DeliverySettlement.model_validate_json(raw)
        if body.notSubmitted and body.providerId is not None:
            return JSONResponse(
                {"detail": "Conflicting submission outcome"}, status_code=400, headers=NO_STORE
            )
        received = await asyncio.wait_for(
            service.acknowledge(
                body.id,
                body.claimId,
                body.providerId,
                not_submitted=body.notSubmitted,
            ),
            timeout=15,
        )
    except ValidationError:
        raise HTTPException(400, "Invalid worker request", headers=NO_STORE) from None
    except PermissionError:
        raise HTTPException(403, "Account unavailable", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Attempt email receipt not confirmed", headers=NO_STORE) from None
    return JSONResponse({"environment": lane, "received": received}, headers=NO_STORE)


class ReportBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    messageId: str = Field(
        pattern=r"^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,200}@[A-Za-z0-9.-]{1,200}>$"
    )
    recipientHash: str = Field(pattern=r"^[a-f0-9]{64}$")


class SubmissionBinding(ReportBinding):
    providerId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,160}$")


class FeedbackBatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    submissions: list[SubmissionBinding] = Field(max_length=20)
    bounces: list[ReportBinding] = Field(max_length=100)


@router.post("/attempt-email/feedback-state", include_in_schema=False)
async def feedback_state(request: Request):
    raw, lane = await _worker_body(request, "feedback-state", delivery=False)
    if raw != b"{}":
        raise HTTPException(400, "Invalid worker request", headers=NO_STORE)
    try:
        result = await asyncio.wait_for(feedback.read(), timeout=15)
    except Exception:
        raise HTTPException(503, "Attempt feedback unavailable", headers=NO_STORE) from None
    return JSONResponse({"environment": lane, **result}, headers=NO_STORE)


@router.post("/attempt-email/feedback-apply", include_in_schema=False)
async def feedback_apply(request: Request):
    raw, lane = await _worker_body(request, "feedback-apply", delivery=False)
    try:
        body = FeedbackBatch.model_validate_json(raw)
        complete = await asyncio.wait_for(feedback.apply(**body.model_dump()), timeout=25)
    except ValidationError:
        raise HTTPException(400, "Invalid feedback request", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Attempt feedback not confirmed", headers=NO_STORE) from None
    return JSONResponse({"environment": lane, "complete": complete}, headers=NO_STORE)


@router.put("/attempt-email/preferences")
async def choose(body: AttemptEmailChoice, uid: str = Depends(require_firebase_auth_read_only)):
    try:
        result = await asyncio.wait_for(
            service.choose(
                uid,
                enabled=body.enabled,
                expected_revision=body.expectedRevision,
                disclosure=body.disclosureVersion,
            ),
            timeout=30,
        )
    except VerifiedEmailRequired:
        raise HTTPException(409, {"code": "verified_email_required"}, headers=NO_STORE) from None
    except PreferenceConflict:
        raise HTTPException(409, {"code": "preference_conflict"}, headers=NO_STORE) from None
    except PermissionError:
        raise HTTPException(403, "Attempt email unavailable", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(
            503, "Choice not confirmed; refresh before retrying", headers=NO_STORE
        ) from None
    return JSONResponse(result, headers=NO_STORE)
