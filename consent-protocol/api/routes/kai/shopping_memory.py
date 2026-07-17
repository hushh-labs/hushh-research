"""Kai Shopping-Memory consent-gated endpoint.

Exposes the receipt-memory projection to MCP agents and other API consumers
that authenticate via a scoped Hushh consent token rather than Firebase auth.

Consent scope required: ``attr.shopping.*``  (wildcard) or any broader scope
that covers it (e.g. ``pkm.read``, ``vault.owner``).

Security posture
----------------
* Token signature and expiry validated by ``validate_token_with_db``.
* ``user_id`` in the request body **must** match the ``user_id`` encoded in
  the consent token — no cross-user data access.
* The projection is derived deterministically from the receipt rows already
  stored in the DB; no raw email payloads are returned.
* All PII is aggregated (merchant names, totals, patterns) — never raw
  financial account details.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.services.receipt_memory_service import (
    RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS,
    RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS,
    get_receipt_memory_preview_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Shopping Memory"])


class ShoppingMemoryRequest(BaseModel):
    user_id: str = Field(min_length=1, description="Firebase UID of the user")
    consent_token: str = Field(
        min_length=1,
        description=(
            "Hushh consent token issued for scope 'attr.shopping.*' "
            "(or any broader scope that covers it)."
        ),
    )
    force_refresh: bool = Field(
        default=False,
        description="When True, bypass the cached artifact and rebuild the projection.",
    )
    inference_window_days: int = Field(
        default=RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS,
        ge=1,
        le=730,
        description="How many days of receipt history to include in the projection.",
    )
    highlights_window_days: int = Field(
        default=RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS,
        ge=1,
        le=365,
        description="Recency window for the 'recent highlights' section.",
    )


@router.post("/consent/shopping-memory")
async def get_shopping_memory(payload: ShoppingMemoryRequest):
    """Return a privacy-safe shopping-memory projection for the authenticated user.

    The response contains:
    - ``merchant_affinity``: ranked list of merchants the user shops at most
    - ``purchase_patterns``: detected recurring / periodic purchase patterns
    - ``recent_highlights``: notable purchases in the highlights window
    - ``top_currency_summary``: dominant currency and total spend estimate
    - ``watermark``: provenance metadata (receipt count, date range, schema version)

    All figures are aggregated totals — no individual transaction details,
    raw email payloads, or account numbers are included.

    Requires consent token with scope ``attr.shopping.*``.
    """
    # ------------------------------------------------------------------
    # 1. Consent validation (signature + expiry + revocation + scope)
    # ------------------------------------------------------------------
    valid, reason, token_obj = await validate_token_with_db(
        payload.consent_token,
        expected_scope="attr.shopping.*",
    )

    if not valid:
        logger.warning(
            "shopping_memory.access_denied user_id=%s reason=%s",
            payload.user_id,
            reason,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "SHOPPING_MEMORY_ACCESS_DENIED",
                "message": f"Consent validation failed: {reason}",
                "required_scope": "attr.shopping.*",
                "remedy": (
                    "Call request_consent with scope='attr.shopping.*' "
                    "and use the returned token here."
                ),
            },
        )

    # ------------------------------------------------------------------
    # 2. User-ID binding — token must be issued for the requested user
    # ------------------------------------------------------------------
    if str(token_obj.user_id) != payload.user_id:
        logger.warning(
            "shopping_memory.user_mismatch token_user=%s request_user=%s",
            token_obj.user_id,
            payload.user_id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "SHOPPING_MEMORY_USER_MISMATCH",
                "message": "Token user_id does not match requested user_id.",
                "privacy_notice": (
                    "Consent tokens are cryptographically bound to the user "
                    "they were issued for and cannot be reused across accounts."
                ),
            },
        )

    # ------------------------------------------------------------------
    # 3. Build the projection
    # ------------------------------------------------------------------
    try:
        service = get_receipt_memory_preview_service()
        projection = await service.build_preview(
            user_id=payload.user_id,
            force_refresh=payload.force_refresh,
            inference_window_days=payload.inference_window_days,
            highlights_window_days=payload.highlights_window_days,
        )
        logger.info("shopping_memory.projection_built user_id=%s", payload.user_id)
        return projection

    except Exception as exc:
        logger.exception(
            "shopping_memory.projection_failed user_id=%s", payload.user_id
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "SHOPPING_MEMORY_TEMPORARILY_UNAVAILABLE",
                "message": (
                    "We couldn't build your shopping summary right now. "
                    "Please try again in a moment."
                ),
                "retryable": True,
            },
        ) from exc
