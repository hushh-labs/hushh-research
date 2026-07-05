"""Information Marketplace opportunity-signal routes (durable, owner-scoped).

Proactive flashcards for Agent One. Unlike the derived-fresh nudges elsewhere in
the app, these signals are real records (migration 077) with a persisted lifecycle:
they can be snoozed ("remind me later" → reappears the next day), dismissed, or
marked published, and that state survives reloads and days.

Consent-first: no route here publishes anything. `POST /{id}/publish` only records
that the owner acted on the signal; the actual publish runs through the existing
consent-first posture flow. All routes are owner-token gated.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.opportunity_signal_derivation_service import (
    OpportunitySignalDerivationService,
)
from hushh_mcp.services.opportunity_signal_service import OpportunitySignalService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/one/marketplace/opportunities",
    tags=["One Information Marketplace Opportunities"],
)


def _service() -> OpportunitySignalService:
    return OpportunitySignalService()


class SnoozeBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    until_days: int = Field(default=1, alias="untilDays", ge=1, le=365)


class AuthorSignalBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    kind: str = Field(max_length=16)
    domain: str = Field(max_length=128)
    title: str = Field(max_length=200)
    dedupe_key: str = Field(alias="dedupeKey", max_length=256)
    scope_handle: str | None = Field(default=None, alias="scopeHandle", max_length=256)
    body: str | None = Field(default=None, max_length=2000)
    event_date: str | None = Field(default=None, alias="eventDate", max_length=32)
    suggested_price_cents: int = Field(default=0, alias="suggestedPriceCents", ge=0, le=100_000_000)
    currency: str = Field(default="USD", max_length=8)
    metadata: dict[str, Any] = Field(default_factory=dict)


@router.get("")
async def list_due_opportunities(
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = token_data["user_id"]
    # Derive-on-read: refresh server-derivable `intent` signals from the owner's
    # publishable slices before listing. Best-effort — a derivation hiccup must not
    # break the read of already-persisted signals.
    try:
        await OpportunitySignalDerivationService().derive_for_user(user_id=user_id)
    except Exception:
        logger.exception("opportunities.derive_failed")
    try:
        opportunities = await _service().list_due(user_id=user_id)
        return {"opportunities": opportunities}
    except Exception:
        logger.exception("opportunities.list_due_failed")
        raise HTTPException(status_code=500, detail="Could not load opportunities")


@router.post("")
async def author_opportunity(
    body: AuthorSignalBody,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        signal = await _service().create_signal(
            user_id=token_data["user_id"],
            kind=body.kind,
            domain=body.domain,
            title=body.title,
            dedupe_key=body.dedupe_key,
            source="authored",
            scope_handle=body.scope_handle,
            body=body.body,
            event_date=body.event_date,
            suggested_price_cents=body.suggested_price_cents,
            currency=body.currency,
            metadata=body.metadata,
        )
        return {"opportunity": signal}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception:
        logger.exception("opportunities.author_failed")
        raise HTTPException(status_code=500, detail="Could not create opportunity")


@router.post("/{signal_id}/snooze")
async def snooze_opportunity(
    body: SnoozeBody | None = None,
    signal_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    result: dict[str, Any] = await _service().snooze(
        user_id=token_data["user_id"], signal_id=signal_id
    )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return result


@router.post("/{signal_id}/dismiss")
async def dismiss_opportunity(
    signal_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    result: dict[str, Any] = await _service().dismiss(
        user_id=token_data["user_id"], signal_id=signal_id
    )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return result


@router.post("/{signal_id}/publish")
async def mark_opportunity_published(
    signal_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    result: dict[str, Any] = await _service().mark_published(
        user_id=token_data["user_id"], signal_id=signal_id
    )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return result
